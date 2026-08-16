const path = require('path');
const express = require('express');
const db = require('./db');
const S = require('./services');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// helper yang tersedia di semua view
const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const angka = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('id-ID');
const tglID = (s) => {
  if (!s) return '-';
  const [y, m, d] = s.split('-');
  return `${d} ${['','Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'][+m]} ${y}`;
};

app.use((req, res, next) => {
  res.locals.rupiah = rupiah;
  res.locals.angka = angka;
  res.locals.tglID = tglID;
  res.locals.hariIni = S.hariIni();
  res.locals.jalur = req.path;
  res.locals.ok = req.query.ok || null;
  res.locals.err = req.query.err || null;
  res.locals.namaUsaha = S.pengaturan('nama_usaha', 'Bubur Bayi Procil');
  res.locals.saldoKas = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END),0) s FROM mutasi_kas").get().s;
  res.locals.adaBar = false;
  next();
});

// bungkus handler supaya galat jadi redirect dengan pesan, bukan stack trace
const aman = (tujuan, fn) => (req, res) => {
  try {
    const pesan = fn(req, res);
    if (!res.headersSent) res.redirect(`${tujuan}?ok=${encodeURIComponent(pesan || 'Tersimpan.')}`);
  } catch (e) {
    res.redirect(`${tujuan}?err=${encodeURIComponent(e.message)}`);
  }
};

// mengubah field form bergaya items[0][qty] menjadi array objek
function ambilBaris(body, nama) {
  const src = body[nama];
  if (!src) return [];
  if (Array.isArray(src)) return src;
  return Object.keys(src).sort((a, b) => a - b).map((k) => src[k]);
}

// ============ DASHBOARD ============
app.get('/', (req, res) => {
  res.render('dashboard', { judul: 'Dashboard', d: S.ringkasanDashboard() });
});

// ============ KASIR / PENJUALAN ============
app.get('/kasir', (req, res) => {
  const kanal = ['retail', 'pesanan', 'grab'].includes(req.query.kanal) ? req.query.kanal : 'retail';

  const qAntrean = db.prepare(`
    SELECT p.id, p.no_pesanan, p.tanggal_kirim, p.total, p.ref_luar,
           COALESCE(c.nama,'Umum') pelanggan,
           (SELECT COALESCE(SUM(qty),0) FROM pesanan_detail WHERE pesanan_id=p.id) total_qty
      FROM pesanan p LEFT JOIN pelanggan c ON c.id=p.pelanggan_id
     WHERE p.status='baru' AND p.kanal=? ORDER BY p.tanggal_kirim, p.id`);
  const qItem = db.prepare(`
    SELECT d.produk_id, d.qty, d.harga, d.subtotal, pr.nama
      FROM pesanan_detail d JOIN produk pr ON pr.id=d.produk_id WHERE d.pesanan_id=?`);
  const antrean = (k) => qAntrean.all(k).map((o) => ({ ...o, items: qItem.all(o.id) }));

  res.render('kasir', {
    judul: 'Kasir', kanal, adaBar: true,
    produk: S.daftarProdukDenganStok('retail'),
    antreanPesanan: antrean('pesanan'),
    antreanGrab: antrean('grab'),
    komisiGrab: S.num(S.pengaturan('komisi_grab_persen', '20')),
    notaTerakhir: db.prepare('SELECT * FROM penjualan ORDER BY id DESC LIMIT 8').all(),
  });
});

app.post('/kasir', aman('/kasir', (req) => {
  const b = req.body;
  const items = ambilBaris(b, 'items').filter((i) => S.num(i.qty) > 0);
  const r = S.simpanPenjualan({
    kanal: b.kanal, items, metode_bayar: b.metode_bayar, uang_diterima: b.uang_diterima,
    pesanan_id: b.pesanan_id || null, ref_luar: b.ref_luar || null,
  });
  let p = `Nota ${r.no_nota} tersimpan. Total ${rupiah(r.bruto)}`;
  if (r.komisi) p += `, komisi ${rupiah(r.komisi)}, diterima ${rupiah(r.netto)}`;
  if (r.kembalian > 0) p += `, kembalian ${rupiah(r.kembalian)}`;
  return p + '.';
}));

// ============ PEMESANAN ============
app.get('/pesanan', (req, res) => {
  res.render('pesanan', {
    judul: 'Pemesanan',
    produk: db.prepare(`
      SELECT p.id, p.nama, p.satuan,
        COALESCE((SELECT harga FROM produk_harga WHERE produk_id=p.id AND kanal='pesanan'),0) h_pesanan,
        COALESCE((SELECT harga FROM produk_harga WHERE produk_id=p.id AND kanal='grab'),0)    h_grab,
        COALESCE((SELECT SUM(qty) FROM mutasi_stok WHERE item_tipe='produk' AND item_id=p.id),0) stok
      FROM produk p WHERE p.aktif=1 ORDER BY p.nama`).all(),
    pelanggan: db.prepare('SELECT * FROM pelanggan WHERE aktif=1 ORDER BY nama').all(),
    daftar: db.prepare(`
      SELECT p.*, COALESCE(c.nama,'Umum') pelanggan,
             (SELECT GROUP_CONCAT(pr.nama || ' x' || CAST(d.qty AS INT), ', ')
                FROM pesanan_detail d JOIN produk pr ON pr.id=d.produk_id WHERE d.pesanan_id=p.id) isi
        FROM pesanan p LEFT JOIN pelanggan c ON c.id=p.pelanggan_id
       ORDER BY p.id DESC LIMIT 30`).all(),
  });
});

app.post('/pesanan', aman('/pesanan', (req) => {
  const b = req.body;
  const items = ambilBaris(b, 'items').filter((i) => S.num(i.qty) > 0);
  const r = S.simpanPesanan({
    tanggal: b.tanggal, tanggal_kirim: b.tanggal_kirim, pelanggan_id: b.pelanggan_id || null,
    kanal: b.kanal, ref_luar: b.ref_luar, catatan: b.catatan, items,
  });
  const tab = r.kanal === 'grab' ? 'GrabFood' : 'Pesanan PO';
  return `${tab} ${r.no_pesanan} tersimpan (${rupiah(r.total)}). Proses lewat menu Kasir → tab ${tab}.`;
}));

app.post('/pesanan/:id/batal', aman('/pesanan', (req) => {
  db.prepare("UPDATE pesanan SET status='batal' WHERE id=? AND status='baru'").run(req.params.id);
  return 'Pesanan dibatalkan.';
}));

// ============ PEMBELIAN ============
app.get('/pembelian', (req, res) => {
  res.render('pembelian', {
    judul: 'Pembelian Bahan',
    bahan: S.daftarBahanDenganStok(),
    supplier: db.prepare('SELECT * FROM supplier WHERE aktif=1 ORDER BY nama').all(),
    daftar: db.prepare(`
      SELECT pb.*, COALESCE(s.nama,'-') supplier,
             (SELECT GROUP_CONCAT(b.nama || ' ' || CAST(d.qty AS INT) || ' ' || b.satuan, ', ')
                FROM pembelian_detail d JOIN bahan b ON b.id=d.bahan_id WHERE d.pembelian_id=pb.id) isi
        FROM pembelian pb LEFT JOIN supplier s ON s.id=pb.supplier_id
       ORDER BY pb.id DESC LIMIT 30`).all(),
  });
});

app.post('/pembelian', aman('/pembelian', (req) => {
  const b = req.body;
  const items = ambilBaris(b, 'items').filter((i) => S.num(i.qty) > 0 && S.num(i.harga_satuan) > 0);
  const r = S.simpanPembelian({
    tanggal: b.tanggal, supplier_id: b.supplier_id || null, cara_bayar: b.cara_bayar,
    catatan: b.catatan, items,
  });
  return `Nota ${r.no_nota} tersimpan (${rupiah(r.total)}). Stok bahan bertambah.`;
}));

// ============ PRODUKSI ============
app.get('/produksi', (req, res) => {
  res.render('produksi', {
    judul: 'Produksi',
    bahan: S.daftarBahanDenganStok(),
    produk: S.daftarProdukDenganStok('retail'),
    resep: db.prepare(`SELECT r.produk_id, r.bahan_id, r.qty, b.nama, b.satuan
                         FROM resep r JOIN bahan b ON b.id=r.bahan_id`).all(),
    daftar: db.prepare(`
      SELECT pr.*,
        (SELECT GROUP_CONCAT(b.nama || ' ' || CAST(pb.qty AS INT) || ' ' || b.satuan, ', ')
           FROM produksi_bahan pb JOIN bahan b ON b.id=pb.bahan_id WHERE pb.produksi_id=pr.id) bahan,
        (SELECT GROUP_CONCAT(p.nama || ' ' || CAST(ph.qty AS INT) || ' ' || p.satuan, ', ')
           FROM produksi_hasil ph JOIN produk p ON p.id=ph.produk_id WHERE ph.produksi_id=pr.id) hasil,
        (SELECT COALESCE(SUM(qty),0) FROM produksi_hasil WHERE produksi_id=pr.id) output
      FROM produksi pr ORDER BY pr.id DESC LIMIT 30`).all(),
  });
});

app.post('/produksi', aman('/produksi', (req) => {
  const b = req.body;
  const r = S.simpanProduksi({
    tanggal: b.tanggal, catatan: b.catatan,
    bahan: ambilBaris(b, 'bahan').filter((x) => S.num(x.qty) > 0),
    hasil: ambilBaris(b, 'hasil').filter((x) => S.num(x.qty) > 0),
  });
  return `Batch ${r.no_batch} selesai. Nilai bahan ${rupiah(r.total_nilai_bahan)}, HPP ${rupiah(r.hpp_satuan)}/porsi.`;
}));

// dipakai form produksi untuk menghitung kebutuhan bahan dari resep
app.post('/api/kebutuhan-resep', (req, res) => {
  try {
    res.json({ ok: true, data: S.kebutuhanDariResep(req.body.rencana || []) });
  } catch (e) {
    res.status(400).json({ ok: false, pesan: e.message });
  }
});

// ============ INVENTORY ============
app.get('/inventory', (req, res) => {
  const tipe = req.query.tipe === 'produk' ? 'produk' : 'bahan';
  const itemId = req.query.item ? Number(req.query.item) : null;
  res.render('inventory', {
    judul: 'Inventory', tipe, itemId,
    bahan: S.daftarBahanDenganStok(),
    produk: S.daftarProdukDenganStok('retail'),
    kartu: itemId ? db.prepare(
      `SELECT * FROM mutasi_stok WHERE item_tipe=? AND item_id=? ORDER BY tanggal DESC, id DESC LIMIT 60`
    ).all(tipe, itemId) : [],
  });
});

// ============ MASTER ============
app.get('/master', (req, res) => {
  const tab = ['produk', 'bahan', 'resep', 'mitra'].includes(req.query.tab) ? req.query.tab : 'produk';
  res.render('master', {
    judul: 'Master Data', tab,
    produk: db.prepare(`
      SELECT p.*,
        (SELECT harga FROM produk_harga WHERE produk_id=p.id AND kanal='retail')  h_retail,
        (SELECT harga FROM produk_harga WHERE produk_id=p.id AND kanal='pesanan') h_pesanan,
        (SELECT harga FROM produk_harga WHERE produk_id=p.id AND kanal='grab')    h_grab
      FROM produk p WHERE p.aktif=1 ORDER BY p.nama`).all(),
    bahan: S.daftarBahanDenganStok(),
    resep: db.prepare(`
      SELECT r.*, p.nama produk, p.satuan satuan_produk, b.nama bahan, b.satuan
        FROM resep r JOIN produk p ON p.id=r.produk_id JOIN bahan b ON b.id=r.bahan_id
       ORDER BY p.nama, b.nama`).all(),
    produkAktif: db.prepare('SELECT * FROM produk WHERE aktif=1 ORDER BY nama').all(),
    supplier: db.prepare('SELECT * FROM supplier WHERE aktif=1 ORDER BY nama').all(),
    pelanggan: db.prepare('SELECT * FROM pelanggan WHERE aktif=1 ORDER BY nama').all(),
    komisiGrab: S.pengaturan('komisi_grab_persen', '20'),
  });
});

app.post('/master/produk', aman('/master?tab=produk', (req) => {
  const b = req.body;
  if (!b.nama || !b.nama.trim()) throw new Error('Nama produk wajib diisi.');
  const id = b.id ? Number(b.id) : db.prepare('INSERT INTO produk (nama,satuan) VALUES (?,?)')
    .run(b.nama.trim(), b.satuan || 'porsi').lastInsertRowid;
  if (b.id) db.prepare('UPDATE produk SET nama=?, satuan=? WHERE id=?').run(b.nama.trim(), b.satuan || 'porsi', id);
  const up = db.prepare(`INSERT INTO produk_harga (produk_id,kanal,harga) VALUES (?,?,?)
                         ON CONFLICT(produk_id,kanal) DO UPDATE SET harga=excluded.harga`);
  for (const k of ['retail', 'pesanan', 'grab']) up.run(id, k, S.num(b['h_' + k]));
  return 'Produk tersimpan.';
}));

app.post('/master/bahan', aman('/master?tab=bahan', (req) => {
  const b = req.body;
  if (!b.nama || !b.nama.trim()) throw new Error('Nama bahan wajib diisi.');
  if (b.id) {
    db.prepare('UPDATE bahan SET nama=?, satuan=?, stok_min=? WHERE id=?')
      .run(b.nama.trim(), b.satuan || 'gram', S.num(b.stok_min), Number(b.id));
  } else {
    db.prepare('INSERT INTO bahan (nama,satuan,stok_min) VALUES (?,?,?)')
      .run(b.nama.trim(), b.satuan || 'gram', S.num(b.stok_min));
  }
  return 'Bahan tersimpan.';
}));

app.post('/master/resep', aman('/master?tab=resep', (req) => {
  const b = req.body;
  if (!b.produk_id || !b.bahan_id) throw new Error('Produk dan bahan wajib dipilih.');
  if (S.num(b.qty) <= 0) throw new Error('Jumlah pemakaian harus lebih dari nol.');
  db.prepare(`INSERT INTO resep (produk_id,bahan_id,qty) VALUES (?,?,?)
              ON CONFLICT(produk_id,bahan_id) DO UPDATE SET qty=excluded.qty`)
    .run(b.produk_id, b.bahan_id, S.num(b.qty));
  return 'Resep tersimpan.';
}));

app.post('/master/resep/:id/hapus', aman('/master?tab=resep', (req) => {
  db.prepare('DELETE FROM resep WHERE id=?').run(req.params.id);
  return 'Baris resep dihapus.';
}));

app.post('/master/mitra', aman('/master?tab=mitra', (req) => {
  const b = req.body;
  if (!b.nama || !b.nama.trim()) throw new Error('Nama wajib diisi.');
  const tabel = b.jenis === 'pelanggan' ? 'pelanggan' : 'supplier';
  db.prepare(`INSERT INTO ${tabel} (nama,telp) VALUES (?,?)`).run(b.nama.trim(), b.telp || null);
  return (b.jenis === 'pelanggan' ? 'Pelanggan' : 'Supplier') + ' tersimpan.';
}));

app.post('/master/pengaturan', aman('/master?tab=produk', (req) => {
  S.setPengaturan('komisi_grab_persen', S.num(req.body.komisi_grab_persen));
  if (req.body.nama_usaha) S.setPengaturan('nama_usaha', req.body.nama_usaha.trim());
  return 'Pengaturan disimpan.';
}));

// ============ KAS ============
app.get('/kas', (req, res) => {
  const dari = req.query.dari || S.hariIni();
  const sampai = req.query.sampai || dari;
  res.render('kas', {
    judul: 'Buku Kas', k: S.bukuKas(dari, sampai), dari, sampai,
    piutang: S.piutangGrab(),
    riwayatCair: db.prepare(
      'SELECT * FROM pencairan_grab ORDER BY id DESC LIMIT 10').all(),
  });
});

app.post('/kas/biaya', aman('/kas', (req) => {
  S.simpanBiaya(req.body);
  return 'Biaya operasional tercatat.';
}));

app.post('/kas/pencairan-grab', aman('/kas', (req) => {
  const r = S.simpanPencairanGrab(req.body);
  return `Pencairan ${rupiah(r.jumlah)} masuk kas. Sisa saldo Grab ${rupiah(r.sisa)}.`;
}));

app.post('/kas/modal', aman('/kas', (req) => {
  const r = S.simpanModal(req.body);
  return `Setoran modal ${rupiah(r.jumlah)} tercatat.`;
}));

// ============ LAPORAN ============
app.get('/laporan/penjualan', (req, res) => {
  const dari = req.query.dari || S.hariIni();
  const sampai = req.query.sampai || dari;
  res.render('lap-penjualan', { judul: 'Laporan Penjualan', l: S.laporanPenjualan(dari, sampai), dari, sampai });
});

app.get('/laporan/pembelian-produksi', (req, res) => {
  const dari = req.query.dari || S.hariIni();
  const sampai = req.query.sampai || dari;
  res.render('lap-pembelian-produksi', {
    judul: 'Laporan Pembelian & Produksi', l: S.laporanPembelianProduksi(dari, sampai), dari, sampai });
});

app.get('/laporan/keuangan', (req, res) => {
  const dari = req.query.dari || S.hariIni();
  const sampai = req.query.sampai || dari;
  res.render('lap-keuangan', { judul: 'Laporan Keuangan', l: S.laporanKeuangan(dari, sampai), dari, sampai });
});

app.use((req, res) => res.status(404).render('galat', { judul: 'Tidak ditemukan', pesan: 'Halaman tidak ada.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('galat', { judul: 'Galat', pesan: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ERP Mini berjalan di http://localhost:${PORT}`));
