#!/usr/bin/env node
/**
 * Bulk-import de CSVs de afiliados TikTok desde una carpeta local.
 *
 * Uso:
 *   node scripts/bulk-import-tts.js <ruta-raíz> [--dry-run]
 *
 * Estructura esperada (cualquier profundidad — recorre recursivamente):
 *   <root>/.../<carpeta-con-fecha>/<archivo>.csv
 *
 * La fecha se detecta automáticamente del nombre de la carpeta, soportando:
 *   "01-04-2026", "01_04_2026", "2026-04-01", "01.04.2026", "1-4-26"
 *   También del nombre del archivo si la carpeta no tiene fecha.
 *
 * Identifica el CSV de afiliados por contener "afiliado" o "affiliate" en el
 * nombre, o por tener columnas típicas (ID de pedido, Creador, etc).
 *
 * Re-popula tts_affiliate_orders con la nueva granularidad por producto
 * (is_primary correcto), reemplazando registros existentes del mismo día.
 */

const fs   = require('fs');
const path = require('path');
const { initDb, getDb } = require('../src/db');
const { parseTTSAffiliateCSV } = require('../src/services/ttsCsvParser');

function round(n, d = 2) { return Math.round((n || 0) * Math.pow(10, d)) / Math.pow(10, d); }

// ─── Detección de fecha ─────────────────────────────────────────────────
function parseDateFromName(name) {
  if (!name) return null;
  const s = name.replace(/[._]/g, '-');
  // YYYY-MM-DD
  let m = s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  // DD-MM-YYYY
  m = s.match(/(\d{1,2})-(\d{1,2})-(20\d{2})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // DD-MM-YY
  m = s.match(/(\d{1,2})-(\d{1,2})-(\d{2})\b/);
  if (m) {
    const yy = parseInt(m[3], 10);
    const yyyy = yy + (yy >= 70 ? 1900 : 2000);
    return `${yyyy}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return null;
}

function detectDateFromPath(filePath) {
  // Probar primero el nombre de la carpeta directa, luego subir niveles
  const parts = filePath.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i--) {
    const d = parseDateFromName(parts[i]);
    if (d) return d;
  }
  return null;
}

// ─── Recorrido recursivo ────────────────────────────────────────────────
function findCSVs(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && /\.csv$/i.test(ent.name)) out.push(full);
    }
  }
  walk(rootDir);
  return out;
}

function looksLikeAffiliateCSV(filePath, parsed) {
  const name = path.basename(filePath).toLowerCase();
  if (/afiliad|affili/.test(name)) return true;
  // Fallback: tiene columnas típicas
  const hdr = (parsed.header || []).map(h => h.toLowerCase()).join(' ');
  return /creador|creator/.test(hdr) && /pedido|order/.test(hdr);
}

// ─── Persistencia (espejo de persistAffiliateOrders en routes/tts.js) ───
function buildPersist(db) {
  // Mapa SKU → grupo
  const skusRaw = db.prepare('SELECT sku, grupo FROM skus').all();
  const skuMap = {};
  for (const s of skusRaw) skuMap[s.sku] = s;
  function resolveGrupo(rawSku) {
    if (!rawSku) return '';
    const sku = rawSku.toUpperCase().trim();
    const sd = skuMap[sku]
      || skuMap[sku.replace(/-[A-Z0-9]+$/, '-')]
      || skuMap[sku.replace(/-[A-Z0-9]+$/, '')];
    return (sd?.grupo || sku).toUpperCase();
  }

  const upsert = db.prepare(`
    INSERT INTO tts_affiliate_orders (
      order_date, csv_order_id, tiktok_username,
      product_name, product_id, csv_sku_id, sku, grupo,
      price, revenue, commission, comm_type,
      video_id, content_type, order_status, fully_refunded, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(csv_order_id, csv_sku_id) DO UPDATE SET
      order_date=excluded.order_date, tiktok_username=excluded.tiktok_username,
      product_name=excluded.product_name, product_id=excluded.product_id,
      sku=excluded.sku, grupo=excluded.grupo, price=excluded.price,
      revenue=excluded.revenue, commission=excluded.commission, comm_type=excluded.comm_type,
      video_id=excluded.video_id, content_type=excluded.content_type,
      order_status=excluded.order_status, fully_refunded=excluded.fully_refunded,
      is_primary=excluded.is_primary
  `);

  return (date, rows) => {
    let count = 0;
    db.transaction(() => {
      for (const af of rows) {
        const orderId = String(af.orderId || '').trim();
        if (!orderId) continue;
        const sku = (af.sellerSku || af.skus?.[0] || '').toUpperCase().trim();
        const grupo = resolveGrupo(sku);
        const commPctAds      = parseFloat(af.commPctAds) || 0;
        const commPctStandard = parseFloat(af.commPctStandard) || 0;
        const commission      = (parseFloat(af.commReal) || 0) + (parseFloat(af.commRealAds) || 0);
        const revenue         = parseFloat(af.settlementAmount) || 0;
        let commType = 'none';
        if (commPctAds > 0) commType = 'paid';
        else if (commPctStandard > 0) commType = 'org';
        const refunded = af.fullyRefunded === true;
        const isPrimary = af.isPrimary === false ? 0 : 1;
        const csvSkuId = sku || '__primary__';
        upsert.run(
          date, orderId, (af.creatorName || '').toLowerCase().trim(),
          af.productName || null, null, csvSkuId, sku || null, grupo || null,
          round(revenue), round(revenue), round(commission), commType,
          af.contentId || null, af.contentType || null,
          af.orderStatus || null, refunded ? 1 : 0, isPrimary,
        );
        count++;
      }
    })();
    return count;
  };
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const rootDir = args.find(a => !a.startsWith('--'));
  if (!rootDir) {
    console.error('Uso: node scripts/bulk-import-tts.js <ruta-raíz> [--dry-run]');
    process.exit(1);
  }
  const absRoot = path.resolve(rootDir);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    console.error(`Carpeta no existe: ${absRoot}`);
    process.exit(1);
  }

  console.log(`\n📂 Escaneando ${absRoot}...`);
  const csvs = findCSVs(absRoot);
  console.log(`   ${csvs.length} CSVs encontrados\n`);

  await initDb();
  const db = getDb();
  const persist = buildPersist(db);

  const summary = { ok: 0, skipped: 0, errors: 0, totalRows: 0, byDate: {} };

  for (const filePath of csvs) {
    const rel = path.relative(absRoot, filePath);
    let parsed, fileText;
    try {
      fileText = fs.readFileSync(filePath, 'utf8');
      parsed = parseTTSAffiliateCSV(fileText);
    } catch (e) {
      console.log(`  ❌ ${rel}: ${e.message}`);
      summary.errors++;
      continue;
    }
    if (parsed.error) {
      console.log(`  ⏭  ${rel}: ${parsed.error}`);
      summary.skipped++;
      continue;
    }
    if (!looksLikeAffiliateCSV(filePath, parsed)) {
      console.log(`  ⏭  ${rel}: no parece CSV de afiliados`);
      summary.skipped++;
      continue;
    }
    const dateFromPath = detectDateFromPath(filePath);
    const rows = parsed.rows;
    const n = rows.length;

    // Estrategia 1: fecha del path → todas las filas a esa fecha
    // Estrategia 2: sin fecha en path → agrupar por orderDate de cada fila
    //               (CSVs de TikTok suelen traer varios días en un export grande)
    const groups = {};
    if (dateFromPath) {
      groups[dateFromPath] = rows;
    } else {
      let withoutDate = 0;
      for (const r of rows) {
        const d = r.orderDate;
        if (!d) { withoutDate++; continue; }
        if (!groups[d]) groups[d] = [];
        groups[d].push(r);
      }
      if (Object.keys(groups).length === 0) {
        console.log(`  ⚠️  ${rel}: sin fecha en path ni en datos — saltado`);
        summary.skipped++;
        continue;
      }
      if (withoutDate > 0) {
        console.log(`  ⚠️  ${rel}: ${withoutDate} filas sin fecha — ignoradas`);
      }
    }

    const groupDates = Object.keys(groups).sort();
    if (dryRun) {
      const detail = groupDates.map(d => `${d} (${groups[d].length})`).join(', ');
      console.log(`  🔍 ${rel}  →  ${groupDates.length} día${groupDates.length===1?'':'s'}: ${detail}`);
    } else {
      // Borrar todos los días afectados antes de insertar (idempotente real)
      const delStmt = db.prepare('DELETE FROM tts_affiliate_orders WHERE order_date = ?');
      for (const d of groupDates) delStmt.run(d);
      let totalInserted = 0;
      for (const d of groupDates) {
        const ins = persist(d, groups[d]);
        totalInserted += ins;
        summary.byDate[d] = (summary.byDate[d] || 0) + ins;
      }
      const detail = groupDates.length === 1
        ? `${groupDates[0]} (${totalInserted} filas)`
        : `${groupDates.length} días, ${totalInserted} filas`;
      console.log(`  ✓ ${rel}  →  ${detail}`);
    }
    summary.ok++;
    summary.totalRows += n;
  }

  console.log(`\n📊 Resumen: ${summary.ok} OK · ${summary.skipped} skipped · ${summary.errors} errores`);
  console.log(`   ${summary.totalRows} filas totales procesadas`);
  if (!dryRun) {
    const dates = Object.keys(summary.byDate).sort();
    console.log(`   ${dates.length} días persistidos: ${dates[0] || '—'} → ${dates[dates.length-1] || '—'}`);
  } else {
    console.log('   (dry-run: no se escribió en la DB)');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
