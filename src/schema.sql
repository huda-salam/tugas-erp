-- Skema ERP Mini - Bubur Bayi Procil
-- Prinsip: stok TIDAK disimpan sebagai kolom yang di-UPDATE manual.
-- Stok = SUM(mutasi_stok.qty). Nilai persediaan = SUM(mutasi_stok.nilai).

PRAGMA foreign_keys = ON;

-- ============ MASTER ============
CREATE TABLE IF NOT EXISTS supplier (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nama    TEXT NOT NULL,
  telp    TEXT,
  aktif   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pelanggan (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  nama    TEXT NOT NULL,
  telp    TEXT,
  aktif   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bahan (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nama      TEXT NOT NULL,
  satuan    TEXT NOT NULL DEFAULT 'gram',
  stok_min  REAL NOT NULL DEFAULT 0,
  -- harga rata-rata bergerak (moving average), diperbarui saat pembelian
  harga_avg REAL NOT NULL DEFAULT 0,
  aktif     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS produk (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  nama     TEXT NOT NULL,
  satuan   TEXT NOT NULL DEFAULT 'porsi',
  -- HPP rata-rata bergerak, diperbarui saat produksi selesai
  hpp_avg  REAL NOT NULL DEFAULT 0,
  aktif    INTEGER NOT NULL DEFAULT 1
);

-- Harga jual dipisah per kanal supaya tidak beranak kolom tiap ada kanal baru
CREATE TABLE IF NOT EXISTS produk_harga (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  produk_id  INTEGER NOT NULL REFERENCES produk(id) ON DELETE CASCADE,
  kanal      TEXT NOT NULL CHECK (kanal IN ('retail','pesanan','grab')),
  harga      REAL NOT NULL DEFAULT 0,
  UNIQUE (produk_id, kanal)
);

-- Resep / BOM: kebutuhan bahan untuk 1 satuan produk
CREATE TABLE IF NOT EXISTS resep (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  produk_id INTEGER NOT NULL REFERENCES produk(id) ON DELETE CASCADE,
  bahan_id  INTEGER NOT NULL REFERENCES bahan(id) ON DELETE CASCADE,
  qty       REAL NOT NULL,
  UNIQUE (produk_id, bahan_id)
);

-- ============ PEMBELIAN ============
CREATE TABLE IF NOT EXISTS pembelian (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  no_nota     TEXT NOT NULL UNIQUE,
  tanggal     TEXT NOT NULL,
  supplier_id INTEGER REFERENCES supplier(id),
  cara_bayar  TEXT NOT NULL DEFAULT 'tunai' CHECK (cara_bayar IN ('tunai','utang')),
  total       REAL NOT NULL DEFAULT 0,
  catatan     TEXT,
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pembelian_detail (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pembelian_id  INTEGER NOT NULL REFERENCES pembelian(id) ON DELETE CASCADE,
  bahan_id      INTEGER NOT NULL REFERENCES bahan(id),
  qty           REAL NOT NULL,
  harga_satuan  REAL NOT NULL,
  subtotal      REAL NOT NULL
);

-- ============ PRODUKSI ============
CREATE TABLE IF NOT EXISTS produksi (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  no_batch    TEXT NOT NULL UNIQUE,
  tanggal     TEXT NOT NULL,
  catatan     TEXT,
  total_nilai_bahan REAL NOT NULL DEFAULT 0,
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS produksi_bahan (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  produksi_id INTEGER NOT NULL REFERENCES produksi(id) ON DELETE CASCADE,
  bahan_id    INTEGER NOT NULL REFERENCES bahan(id),
  qty         REAL NOT NULL,
  nilai       REAL NOT NULL   -- qty * harga_avg saat itu
);

CREATE TABLE IF NOT EXISTS produksi_hasil (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  produksi_id INTEGER NOT NULL REFERENCES produksi(id) ON DELETE CASCADE,
  produk_id   INTEGER NOT NULL REFERENCES produk(id),
  qty         REAL NOT NULL,
  hpp_satuan  REAL NOT NULL   -- nilai bahan batch / total qty output
);

-- ============ PEMESANAN ============
CREATE TABLE IF NOT EXISTS pesanan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  no_pesanan    TEXT NOT NULL UNIQUE,
  tanggal       TEXT NOT NULL,
  tanggal_kirim TEXT,
  pelanggan_id  INTEGER REFERENCES pelanggan(id),
  -- kanal asal pesanan: 'pesanan' = PO langsung, 'grab' = order masuk dari GrabFood
  kanal         TEXT NOT NULL DEFAULT 'pesanan',
  ref_luar      TEXT,          -- nomor order GrabFood / nama driver
  status        TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','selesai','batal')),
  total         REAL NOT NULL DEFAULT 0,
  catatan       TEXT,
  dibuat_pada   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pesanan_detail (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pesanan_id INTEGER NOT NULL REFERENCES pesanan(id) ON DELETE CASCADE,
  produk_id  INTEGER NOT NULL REFERENCES produk(id),
  qty        REAL NOT NULL,
  harga      REAL NOT NULL,
  subtotal   REAL NOT NULL
);

-- ============ PENJUALAN ============
CREATE TABLE IF NOT EXISTS penjualan (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  no_nota       TEXT NOT NULL UNIQUE,
  tanggal       TEXT NOT NULL,
  kanal         TEXT NOT NULL CHECK (kanal IN ('retail','pesanan','grab')),
  pelanggan_id  INTEGER REFERENCES pelanggan(id),
  pesanan_id    INTEGER REFERENCES pesanan(id),
  ref_luar      TEXT,            -- nomor order GrabFood
  metode_bayar  TEXT NOT NULL DEFAULT 'tunai' CHECK (metode_bayar IN ('tunai','qris','grab')),
  bruto         REAL NOT NULL DEFAULT 0,
  komisi        REAL NOT NULL DEFAULT 0,  -- potongan platform (Grab)
  netto         REAL NOT NULL DEFAULT 0,  -- bruto - komisi = yang benar-benar diterima
  hpp           REAL NOT NULL DEFAULT 0,
  uang_diterima REAL NOT NULL DEFAULT 0,
  kembalian     REAL NOT NULL DEFAULT 0,
  dibuat_pada   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS penjualan_detail (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  penjualan_id INTEGER NOT NULL REFERENCES penjualan(id) ON DELETE CASCADE,
  produk_id    INTEGER NOT NULL REFERENCES produk(id),
  qty          REAL NOT NULL,
  harga        REAL NOT NULL,
  subtotal     REAL NOT NULL
);

-- ============ INVENTORY (sumber kebenaran stok) ============
CREATE TABLE IF NOT EXISTS mutasi_stok (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal     TEXT NOT NULL,
  item_tipe   TEXT NOT NULL CHECK (item_tipe IN ('bahan','produk')),
  item_id     INTEGER NOT NULL,
  qty         REAL NOT NULL,   -- positif = masuk, negatif = keluar
  nilai       REAL NOT NULL,   -- nilai rupiah, mengikuti tanda qty
  ref_tipe    TEXT NOT NULL,   -- pembelian | produksi | penjualan | penyesuaian
  ref_id      INTEGER,
  keterangan  TEXT,
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mutasi_stok_item ON mutasi_stok(item_tipe, item_id);
CREATE INDEX IF NOT EXISTS idx_mutasi_stok_tgl  ON mutasi_stok(tanggal);

-- ============ KAS ============
CREATE TABLE IF NOT EXISTS mutasi_kas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal     TEXT NOT NULL,
  jam         TEXT NOT NULL DEFAULT (strftime('%H:%M','now','localtime')),
  tipe        TEXT NOT NULL CHECK (tipe IN ('masuk','keluar')),
  kategori    TEXT NOT NULL,   -- penjualan | pembelian | biaya | modal | pencairan_grab
  keterangan  TEXT NOT NULL,
  jumlah      REAL NOT NULL,
  ref_tipe    TEXT,
  ref_id      INTEGER,
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mutasi_kas_tgl ON mutasi_kas(tanggal);

-- Pencairan saldo GrabMerchant ke kas/rekening.
-- Piutang Grab = SUM(penjualan.netto WHERE kanal='grab') - SUM(pencairan_grab.jumlah)
CREATE TABLE IF NOT EXISTS pencairan_grab (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal     TEXT NOT NULL,
  jumlah      REAL NOT NULL,        -- nilai yang benar-benar masuk kas
  keterangan  TEXT,
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pencairan_grab_tgl ON pencairan_grab(tanggal);

-- Beban operasional di luar HPP (transport, pulsa, gas, dll)
CREATE TABLE IF NOT EXISTS biaya (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal     TEXT NOT NULL,
  kategori    TEXT NOT NULL,
  keterangan  TEXT NOT NULL,
  jumlah      REAL NOT NULL,
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ============ INTAKE PESANAN DARI KANAL LUAR ============
-- Log mentah tiap kiriman yang masuk (WhatsApp / GrabFood), dicatat SEBELUM diolah
-- supaya bisa ditelusuri dan diputar ulang kalau parser salah baca.
CREATE TABLE IF NOT EXISTS pesan_masuk (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sumber         TEXT NOT NULL,          -- whatsapp | grab
  ref_luar       TEXT NOT NULL,          -- id pesan / nomor order dari sistem asal
  pengirim       TEXT,                   -- nomor WA atau nama driver
  isi_mentah     TEXT,                   -- teks apa adanya
  payload        TEXT,                   -- JSON asli
  status         TEXT NOT NULL DEFAULT 'diproses',  -- diproses | draft | gagal
  pesanan_id     INTEGER REFERENCES pesanan(id),
  catatan_parser TEXT,
  diterima_pada  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- kunci idempotensi: kiriman ulang dengan ref yang sama tidak membuat pesanan kedua
  UNIQUE (sumber, ref_luar)
);
CREATE INDEX IF NOT EXISTS idx_pesan_masuk_sumber ON pesan_masuk(sumber, diterima_pada);

-- Draft percakapan WhatsApp yang menunggu balasan "YA" dari pelanggan
CREATE TABLE IF NOT EXISTS wa_sesi (
  pengirim    TEXT PRIMARY KEY,
  draft       TEXT NOT NULL,             -- JSON hasil parser
  dibuat_pada TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Pemetaan kode produk milik kanal luar ke produk kita.
-- Order dari luar membawa kode miliknya sendiri, bukan id kita.
CREATE TABLE IF NOT EXISTS produk_kanal_ref (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  produk_id INTEGER NOT NULL REFERENCES produk(id) ON DELETE CASCADE,
  kanal     TEXT NOT NULL,
  kode_luar TEXT NOT NULL,
  UNIQUE (kanal, kode_luar)
);

CREATE TABLE IF NOT EXISTS pengaturan (
  kunci TEXT PRIMARY KEY,
  nilai TEXT NOT NULL
);
