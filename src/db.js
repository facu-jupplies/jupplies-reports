const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

/**
 * Repara sku_group en ad_spend donde quedó NULL.
 * Prioridad: mapeo manual en campaign_sku_map → inferencia por nombre de campaña.
 * Se ejecuta en cada startup pero es idempotente (solo toca filas con sku_group IS NULL).
 */
function repairAdSpendGroups(db) {
  try {
    const { inferGroupFromCampaignName } = require('./services/calculator');

    // Primero: re-aplicar mapeos manuales existentes
    db.exec(`
      UPDATE ad_spend
      SET sku_group = (
        SELECT m.sku_group FROM campaign_sku_map m
        WHERE m.platform = ad_spend.platform
          AND m.campaign_key = ad_spend.campaign_name
          AND m.is_manual = 1
        LIMIT 1
      ),
      is_manual_map = 1
      WHERE sku_group IS NULL
        AND EXISTS (
          SELECT 1 FROM campaign_sku_map m
          WHERE m.platform = ad_spend.platform
            AND m.campaign_key = ad_spend.campaign_name
            AND m.is_manual = 1
        )
    `);

    // Segundo: inferir por nombre para los que siguen en NULL
    const nullRows = db.prepare(
      "SELECT DISTINCT platform, campaign_name FROM ad_spend WHERE sku_group IS NULL AND campaign_name IS NOT NULL"
    ).all();

    const stmt = db.prepare(
      "UPDATE ad_spend SET sku_group = ?, is_manual_map = 0 WHERE platform = ? AND campaign_name = ? AND sku_group IS NULL"
    );
    const stmtMap = db.prepare(
      "INSERT OR IGNORE INTO campaign_sku_map (platform, campaign_key, sku_group, is_manual, updated_at) VALUES (?, ?, ?, 0, datetime('now'))"
    );

    for (const row of nullRows) {
      const group = inferGroupFromCampaignName(row.campaign_name);
      if (group) {
        stmt.run(group, row.platform, row.campaign_name);
        stmtMap.run(row.platform, row.campaign_name, group);
      }
    }
  } catch (e) {
    // No interrumpir el startup si falla la reparación
    console.warn('[repairAdSpendGroups]', e.message);
  }
}

const DB_PATH = path.join(__dirname, '..', 'jupplies.db');

let _rawDb = null;        // instancia interna de sql.js
let _wrapper = null;      // interfaz pública compatible con mejor-sqlite3
let _inTransaction = false; // flag para no guardar a disco dentro de transacciones
let _savePending = false;    // debounce de saveToDisk fuera de transacciones
let _saveTimer = null;

// ─── Inicialización asíncrona (llamar una vez al arrancar) ─────────────────────
async function initDb() {
  if (_rawDb) return _wrapper;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _rawDb = new SQL.Database(buf);
  } else {
    _rawDb = new SQL.Database();
  }

  _wrapper = buildWrapper(_rawDb);
  initSchema(_wrapper);
  saveToDisk(); // guardar el esquema inicial si es nueva

  return _wrapper;
}

// ─── Guardar el archivo en disco ───────────────────────────────────────────────
// Inmediato cuando se llama desde transaction/exec, debounced desde run() individual.
function saveToDisk() {
  if (!_rawDb) return;
  const data = _rawDb.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  _savePending = false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
}

function saveToDiskDebounced() {
  if (_savePending) return;
  _savePending = true;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveToDisk, 200);
}

// ─── Wrapper que imita la API de better-sqlite3 ────────────────────────────────
function buildWrapper(raw) {
  function rowsToObjects(result) {
    if (!result || result.length === 0) return [];
    const { columns, values } = result[0];
    return values.map(vals => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = vals[i]; });
      return obj;
    });
  }

  function makeStmt(sql) {
    let _pluck = false;

    const stmt = {
      // Devuelve una fila como objeto (o undefined)
      get(...params) {
        const p = params.flat().filter(v => v !== undefined);
        try {
          const res = raw.exec(sql, p.length ? p : undefined);
          if (!res.length || !res[0].values.length) return undefined;
          if (_pluck) return res[0].values[0][0];
          return rowsToObjects(res)[0];
        } catch (e) { throw new Error(`SQL error in get(): ${e.message}\n${sql}`); }
      },

      // Devuelve todas las filas como array de objetos
      all(...params) {
        const p = params.flat().filter(v => v !== undefined);
        try {
          const res = raw.exec(sql, p.length ? p : undefined);
          if (!res.length) return [];
          if (_pluck) return res[0].values.map(v => v[0]);
          return rowsToObjects(res);
        } catch (e) { throw new Error(`SQL error in all(): ${e.message}\n${sql}`); }
      },

      // Ejecuta INSERT/UPDATE/DELETE
      run(...params) {
        const p = params.flat().filter(v => v !== undefined);
        try {
          raw.run(sql, p.length ? p : undefined);
          if (!_inTransaction) saveToDiskDebounced();
          return { changes: raw.getRowsModified() };
        } catch (e) { throw new Error(`SQL error in run(): ${e.message}\n${sql}`); }
      },

      // Activa modo pluck (devuelve solo la primera columna)
      pluck() { _pluck = true; return stmt; },
    };

    return stmt;
  }

  return {
    prepare: (sql) => makeStmt(sql),

    exec(sql) {
      try {
        raw.exec(sql);
        saveToDisk();
      } catch (e) { throw new Error(`SQL exec error: ${e.message}`); }
    },

    pragma(str) {
      try { raw.exec(`PRAGMA ${str}`); } catch (_) { /* ignorar */ }
    },

    transaction(fn) {
      return (...args) => {
        raw.run('BEGIN');
        _inTransaction = true;
        try {
          const result = fn(...args);
          raw.run('COMMIT');
          _inTransaction = false;
          saveToDisk();
          return result;
        } catch (err) {
          _inTransaction = false;
          try { raw.run('ROLLBACK'); } catch (_) {}
          throw err;
        }
      };
    },
  };
}

// ─── Obtener la instancia (solo después de initDb()) ──────────────────────────
function getDb() {
  if (!_wrapper) throw new Error('DB no inicializada. Llamar initDb() primero.');
  return _wrapper;
}

// ─── Esquema de tablas ─────────────────────────────────────────────────────────
function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skus (
      sku          TEXT PRIMARY KEY,
      cost         REAL NOT NULL DEFAULT 0,
      shipping_es  REAL NOT NULL DEFAULT 0,
      shipping_int REAL NOT NULL DEFAULT 0,
      grupo        TEXT NOT NULL DEFAULT '',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_name    TEXT NOT NULL,
      date          TEXT NOT NULL,
      payment_type  TEXT NOT NULL,
      order_total   REAL NOT NULL DEFAULT 0,
      line_sku      TEXT NOT NULL DEFAULT '',
      line_qty      INTEGER NOT NULL DEFAULT 1,
      line_price    REAL NOT NULL DEFAULT 0,
      product_cost  REAL NOT NULL DEFAULT 0,
      shipping_cost REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(order_name, line_sku)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_date       ON orders(date);
    CREATE INDEX IF NOT EXISTS idx_orders_sku        ON orders(line_sku);
    CREATE INDEX IF NOT EXISTS idx_orders_order_name ON orders(order_name);
    CREATE INDEX IF NOT EXISTS idx_orders_payment    ON orders(payment_type);

    CREATE TABLE IF NOT EXISTS cod_tracking (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      order_name     TEXT NOT NULL UNIQUE,
      order_date     TEXT NOT NULL,
      order_total    REAL NOT NULL DEFAULT 0,
      simla_order_id TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      confirmed_at   TEXT,
      delivered_at   TEXT,
      resolved_at    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cod_date   ON cod_tracking(order_date);
    CREATE INDEX IF NOT EXISTS idx_cod_status ON cod_tracking(status);

    CREATE TABLE IF NOT EXISTS ad_spend (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT NOT NULL,
      platform       TEXT NOT NULL,
      campaign_name  TEXT NOT NULL,
      campaign_id    TEXT,
      spend          REAL NOT NULL DEFAULT 0,
      clicks         INTEGER NOT NULL DEFAULT 0,
      conversions    INTEGER NOT NULL DEFAULT 0,
      purchase_value REAL NOT NULL DEFAULT 0,
      sku_group      TEXT,
      is_manual_map  INTEGER NOT NULL DEFAULT 0,
      source         TEXT NOT NULL DEFAULT 'windsor_api',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, platform, campaign_name)
    );

    CREATE INDEX IF NOT EXISTS idx_ads_date     ON ad_spend(date);
    CREATE INDEX IF NOT EXISTS idx_ads_platform ON ad_spend(platform);
    CREATE INDEX IF NOT EXISTS idx_ads_group    ON ad_spend(sku_group);

    CREATE TABLE IF NOT EXISTS campaign_sku_map (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      platform     TEXT NOT NULL,
      campaign_key TEXT NOT NULL,
      sku_group    TEXT NOT NULL,
      is_manual    INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, campaign_key)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tts_history (
      date             TEXT PRIMARY KEY,
      gmv              REAL DEFAULT 0,
      net_profit       REAL DEFAULT 0,
      margin_pct       REAL DEFAULT 0,
      orders           INTEGER DEFAULT 0,
      orders_propio    INTEGER DEFAULT 0,
      orders_paid_afil INTEGER DEFAULT 0,
      orders_org_afil  INTEGER DEFAULT 0,
      gmv_max_spend    REAL DEFAULT 0,
      commission_cost  REAL DEFAULT 0,
      cogs             REAL DEFAULT 0,
      shipping         REAL DEFAULT 0,
      iva              REAL DEFAULT 0,
      tiktok_platform  REAL DEFAULT 0,
      seller_discount  REAL DEFAULT 0,
      cpa              REAL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tts_history_grupos (
      date             TEXT NOT NULL,
      grupo            TEXT NOT NULL,
      orders           INTEGER DEFAULT 0,
      orders_propio    INTEGER DEFAULT 0,
      orders_paid_afil INTEGER DEFAULT 0,
      orders_org_afil  INTEGER DEFAULT 0,
      revenue          REAL DEFAULT 0,
      cogs             REAL DEFAULT 0,
      shipping         REAL DEFAULT 0,
      iva              REAL DEFAULT 0,
      tiktok_platform  REAL DEFAULT 0,
      commission_cost  REAL DEFAULT 0,
      gmv_max_spend    REAL DEFAULT 0,
      seller_discount  REAL DEFAULT 0,
      net_profit       REAL DEFAULT 0,
      margin_pct       REAL DEFAULT 0,
      cpa              REAL DEFAULT 0,
      PRIMARY KEY (date, grupo)
    );
  `);

  // Migraciones — agregar columnas nuevas sin romper DBs existentes
  try { db.exec('ALTER TABLE skus ADD COLUMN is_upsell INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
  // line_position: 0 = SKU principal del pedido, 1+ = upsell (orden de línea en Shopify)
  try { db.exec('ALTER TABLE orders ADD COLUMN line_position INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

  // Migraciones SKU — campos de Simla + envío calculado
  try { db.exec('ALTER TABLE skus ADD COLUMN weight REAL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE skus ADD COLUMN length REAL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE skus ADD COLUMN width REAL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE skus ADD COLUMN height REAL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE skus ADD COLUMN stock INTEGER DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE skus ADD COLUMN shipping_tts REAL DEFAULT 3.10'); } catch (_) {}

  // Migraciones TTS history
  try { db.exec('ALTER TABLE tts_history ADD COLUMN gross_profit REAL DEFAULT 0'); } catch (_) {}
  try { db.exec('ALTER TABLE tts_history_grupos ADD COLUMN display_name TEXT'); } catch (_) {}
  try { db.exec('ALTER TABLE tts_history_grupos ADD COLUMN gross_profit REAL DEFAULT 0'); } catch (_) {}

  // Reparar sku_group en ad_spend que quedaron NULL por la migración agresiva anterior.
  // Re-inferir usando campaign_sku_map (mapeos manuales primero) o por nombre de campaña.
  repairAdSpendGroups(db);

  // Insertar defaults uno por uno para evitar conflictos
  const defaults = [
    ['cod_confirmation_rate', '0.85'],
    ['cod_delivery_rate',     '0.83'],
    ['return_shipping_cost',  '4.00'],
    ['vat_rate',              '1.21'],
    ['windsor_api_key',       ''],
    ['windsor_store',         'shopify__jupplies.myshopify.com'],
    ['app_user',              'admin'],
    ['app_password',          'jupplies2024'],
    ['tts_shopify_store',     '0skwzs-1x.myshopify.com'],
    ['tts_tiktok_account',    '7342908772115005442'],
    ['tts_iva_pct',           '21'],
    ['tts_platform_pct',      '9'],
    ['simla_api_key',         'HLJGMavFx6otUkxIrkW0HAHcNCBMtbzy'],
  ];
  for (const [key, value] of defaults) {
    try {
      db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
    } catch (_) {}
  }
}

// Flush pendiente al cerrar el proceso para no perder datos
process.on('exit', () => { if (_savePending) saveToDisk(); });
process.on('SIGINT', () => { if (_savePending) saveToDisk(); process.exit(0); });

module.exports = { getDb, initDb };
