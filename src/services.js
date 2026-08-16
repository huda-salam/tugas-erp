const db = require('./db');

// ---------- util ----------
const hariIni = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD waktu lokal
const num = (v, d = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

function nomorDokumen(prefix, tabel, kolom, tanggal) {
  const tgl = (tanggal || hariIni()).replace(/-/g, '');
  const like = `${prefix}-${tgl}-%`;
  const row = db.prepare(`SELECT COUNT(*) c FROM ${tabel} WHERE ${kolom} LIKE ?`).get(like);
  return `${prefix}-${tgl}-${String(row.c + 1).padStart(3, '0')}`;
}

function pengaturan(kunci, fallback = '0') {
  const r = db.prepare('SELECT nilai FROM pengaturan WHERE kunci = ?').get(kunci);
  return r ? r.nilai : fallback;
}
function setPengaturan(kunci, nilai) {
  db.prepare('INSERT INTO pengaturan (kunci,nilai) VALUES (?,?) ON CONFLICT(kunci) DO UPDATE SET nilai=excluded.nilai')
    .run(kunci, String(nilai));
}

// ---------- stok (diturunkan dari mutasi_stok, bukan kolom yang di-update) ----------
const qStok = db.prepare(
  `SELECT COALESCE(SUM(qty),0) qty, COALESCE(SUM(nilai),0) nilai
     FROM mutasi_stok WHERE item_tipe = ? AND item_id = ?`
);
const stok = (tipe, id) => qStok.get(tipe, id);

function daftarBahanDenganStok() {
  return db.prepare(`
    SELECT b.*,
           COALESCE(m.qty,0)   AS stok,
           COALESCE(m.nilai,0) AS nilai_persediaan
      FROM bahan b
      LEFT JOIN (SELECT item_id, SUM(qty) qty, SUM(nilai) nilai
                   FROM mutasi_stok WHERE item_tipe='bahan' GROUP BY item_id) m
        ON m.item_id = b.id
     WHERE b.aktif = 1 ORDER BY b.nama`).all();
}

function daftarProdukDenganStok(kanal) {
  return db.prepare(`
    SELECT p.*,
           COALESCE(m.qty,0)   AS stok,
           COALESCE(m.nilai,0) AS nilai_persediaan,
           COALESCE(h.harga,0) AS harga
      FROM produk p
      LEFT JOIN (SELECT item_id, SUM(qty) qty, SUM(nilai) nilai
                   FROM mutasi_stok WHERE item_tipe='produk' GROUP BY item_id) m
        ON m.item_id = p.id
      LEFT JOIN produk_harga h ON h.produk_id = p.id AND h.kanal = ?
     WHERE p.aktif = 1 ORDER BY p.nama`).all(kanal || 'retail');
}

const insMutasiStok = db.prepare(
  `INSERT INTO mutasi_stok (tanggal,item_tipe,item_id,qty,nilai,ref_tipe,ref_id,keterangan)
   VALUES (@tanggal,@item_tipe,@item_id,@qty,@nilai,@ref_tipe,@ref_id,@keterangan)`
);
const insMutasiKas = db.prepare(
  `INSERT INTO mutasi_kas (tanggal,tipe,kategori,keterangan,jumlah,ref_tipe,ref_id)
   VALUES (@tanggal,@tipe,@kategori,@keterangan,@jumlah,@ref_tipe,@ref_id)`
);

// ---------- PEMBELIAN ----------
// Menambah persediaan bahan + memperbarui harga rata-rata bergerak.
// Pembelian TIDAK langsung jadi HPP; HPP baru diakui saat bahan dipakai produksi.
const simpanPembelian = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const items = (data.items || []).filter((i) => i.bahan_id && num(i.qty) > 0);
  if (!items.length) throw new Error('Rincian pembelian masih kosong.');

  const total = items.reduce((s, i) => s + num(i.qty) * num(i.harga_satuan), 0);
  const noNota = nomorDokumen('PB', 'pembelian', 'no_nota', tanggal);

  const { lastInsertRowid: pembelianId } = db.prepare(
    `INSERT INTO pembelian (no_nota,tanggal,supplier_id,cara_bayar,total,catatan)
     VALUES (?,?,?,?,?,?)`
  ).run(noNota, tanggal, data.supplier_id || null, data.cara_bayar || 'tunai', total, data.catatan || null);

  const insDetail = db.prepare(
    `INSERT INTO pembelian_detail (pembelian_id,bahan_id,qty,harga_satuan,subtotal) VALUES (?,?,?,?,?)`
  );
  const updAvg = db.prepare('UPDATE bahan SET harga_avg = ? WHERE id = ?');

  for (const i of items) {
    const qty = num(i.qty);
    const harga = num(i.harga_satuan);
    const subtotal = qty * harga;
    insDetail.run(pembelianId, i.bahan_id, qty, harga, subtotal);

    insMutasiStok.run({
      tanggal, item_tipe: 'bahan', item_id: i.bahan_id, qty, nilai: subtotal,
      ref_tipe: 'pembelian', ref_id: pembelianId, keterangan: `Pembelian ${noNota}`,
    });

    // moving average: (nilai lama + nilai baru) / (qty lama + qty baru)
    const s = stok('bahan', i.bahan_id);
    updAvg.run(s.qty > 0 ? s.nilai / s.qty : harga, i.bahan_id);
  }

  if ((data.cara_bayar || 'tunai') === 'tunai') {
    insMutasiKas.run({
      tanggal, tipe: 'keluar', kategori: 'pembelian',
      keterangan: `Belanja bahan ${noNota}`, jumlah: total,
      ref_tipe: 'pembelian', ref_id: pembelianId,
    });
  }
  return { id: pembelianId, no_nota: noNota, total };
});

// ---------- PRODUKSI ----------
// Bahan keluar dinilai pakai harga rata-rata bergerak.
// HPP produk = total nilai bahan batch / total unit output.
const simpanProduksi = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const bahan = (data.bahan || []).filter((b) => b.bahan_id && num(b.qty) > 0);
  const hasil = (data.hasil || []).filter((h) => h.produk_id && num(h.qty) > 0);
  if (!bahan.length) throw new Error('Bahan baku yang dipakai belum diisi.');
  if (!hasil.length) throw new Error('Hasil produksi belum diisi.');

  // validasi stok sebelum menyentuh apa pun (transaksi akan rollback bila gagal)
  for (const b of bahan) {
    const s = stok('bahan', b.bahan_id);
    if (s.qty < num(b.qty)) {
      const nama = db.prepare('SELECT nama,satuan FROM bahan WHERE id=?').get(b.bahan_id);
      throw new Error(`Stok ${nama.nama} tidak cukup: tersedia ${s.qty} ${nama.satuan}, dibutuhkan ${num(b.qty)}.`);
    }
  }

  const noBatch = data.no_batch || nomorDokumen('PRD', 'produksi', 'no_batch', tanggal);
  const { lastInsertRowid: produksiId } = db.prepare(
    `INSERT INTO produksi (no_batch,tanggal,catatan,total_nilai_bahan) VALUES (?,?,?,0)`
  ).run(noBatch, tanggal, data.catatan || null);

  const insBahan = db.prepare('INSERT INTO produksi_bahan (produksi_id,bahan_id,qty,nilai) VALUES (?,?,?,?)');
  let totalNilaiBahan = 0;

  for (const b of bahan) {
    const qty = num(b.qty);
    const s = stok('bahan', b.bahan_id);
    const hargaRata = s.qty > 0 ? s.nilai / s.qty : 0;
    const nilai = qty * hargaRata;
    totalNilaiBahan += nilai;

    insBahan.run(produksiId, b.bahan_id, qty, nilai);
    insMutasiStok.run({
      tanggal, item_tipe: 'bahan', item_id: b.bahan_id, qty: -qty, nilai: -nilai,
      ref_tipe: 'produksi', ref_id: produksiId, keterangan: `Dipakai batch ${noBatch}`,
    });
  }

  const totalOutput = hasil.reduce((s, h) => s + num(h.qty), 0);
  const hppSatuan = totalOutput > 0 ? totalNilaiBahan / totalOutput : 0;

  const insHasil = db.prepare('INSERT INTO produksi_hasil (produksi_id,produk_id,qty,hpp_satuan) VALUES (?,?,?,?)');
  const updHpp = db.prepare('UPDATE produk SET hpp_avg = ? WHERE id = ?');

  for (const h of hasil) {
    const qty = num(h.qty);
    const nilai = qty * hppSatuan;
    insHasil.run(produksiId, h.produk_id, qty, hppSatuan);
    insMutasiStok.run({
      tanggal, item_tipe: 'produk', item_id: h.produk_id, qty, nilai,
      ref_tipe: 'produksi', ref_id: produksiId, keterangan: `Hasil batch ${noBatch}`,
    });
    const s = stok('produk', h.produk_id);
    updHpp.run(s.qty > 0 ? s.nilai / s.qty : hppSatuan, h.produk_id);
  }

  db.prepare('UPDATE produksi SET total_nilai_bahan = ? WHERE id = ?').run(totalNilaiBahan, produksiId);
  return { id: produksiId, no_batch: noBatch, total_nilai_bahan: totalNilaiBahan, hpp_satuan: hppSatuan };
});

// Hitung kebutuhan bahan dari resep (BOM) — dipakai untuk auto-isi form produksi
function kebutuhanDariResep(rencana) {
  const peta = new Map();
  const q = db.prepare(
    `SELECT r.bahan_id, r.qty, b.nama, b.satuan FROM resep r JOIN bahan b ON b.id=r.bahan_id WHERE r.produk_id=?`
  );
  for (const r of rencana) {
    for (const row of q.all(r.produk_id)) {
      const cur = peta.get(row.bahan_id) || { bahan_id: row.bahan_id, nama: row.nama, satuan: row.satuan, qty: 0 };
      cur.qty += row.qty * num(r.qty);
      peta.set(row.bahan_id, cur);
    }
  }
  return [...peta.values()].map((k) => {
    const s = stok('bahan', k.bahan_id);
    return { ...k, stok: s.qty, cukup: s.qty >= k.qty };
  });
}

// ---------- PEMESANAN ----------
const simpanPesanan = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const items = (data.items || []).filter((i) => i.produk_id && num(i.qty) > 0);
  if (!items.length) throw new Error('Pesanan belum berisi produk.');

  const total = items.reduce((s, i) => s + num(i.qty) * num(i.harga), 0);
  const noPesanan = nomorDokumen('PO', 'pesanan', 'no_pesanan', tanggal);

  const kanal = data.kanal === 'grab' ? 'grab' : 'pesanan';
  // sumber = dari mana pesanan ini datang: manual | whatsapp | grab
  const sumber = ['whatsapp', 'grab'].includes(data.sumber) ? data.sumber : 'manual';
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO pesanan (no_pesanan,tanggal,tanggal_kirim,pelanggan_id,kanal,sumber,ref_luar,status,total,catatan)
     VALUES (?,?,?,?,?,?,?,'baru',?,?)`
  ).run(noPesanan, tanggal, data.tanggal_kirim || null, data.pelanggan_id || null,
        kanal, sumber, data.ref_luar || null, total, data.catatan || null);

  const ins = db.prepare('INSERT INTO pesanan_detail (pesanan_id,produk_id,qty,harga,subtotal) VALUES (?,?,?,?,?)');
  for (const i of items) ins.run(id, i.produk_id, num(i.qty), num(i.harga), num(i.qty) * num(i.harga));

  return { id, no_pesanan: noPesanan, total, kanal, sumber };
});

// ---------- PENJUALAN ----------
// Mengurangi stok produk sebesar HPP rata-rata, mencatat kas masuk sebesar netto.
const simpanPenjualan = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const kanal = data.kanal || 'retail';
  const items = (data.items || []).filter((i) => i.produk_id && num(i.qty) > 0);
  if (!items.length) throw new Error('Belum ada item yang dijual.');

  for (const i of items) {
    const s = stok('produk', i.produk_id);
    if (s.qty < num(i.qty)) {
      const p = db.prepare('SELECT nama,satuan FROM produk WHERE id=?').get(i.produk_id);
      throw new Error(`Stok ${p.nama} tidak cukup: tersedia ${s.qty} ${p.satuan}, diminta ${num(i.qty)}.`);
    }
  }

  const bruto = items.reduce((s, i) => s + num(i.qty) * num(i.harga), 0);
  const persenKomisi = kanal === 'grab' ? num(pengaturan('komisi_grab_persen', '20')) : 0;
  const komisi = Math.round((bruto * persenKomisi) / 100);
  const netto = bruto - komisi;

  const metode = kanal === 'grab' ? 'grab' : (data.metode_bayar || 'tunai');
  const uangDiterima = metode === 'tunai' ? num(data.uang_diterima) : netto;
  if (metode === 'tunai' && uangDiterima < bruto) throw new Error('Uang diterima kurang dari total tagihan.');

  const noNota = nomorDokumen('NJ', 'penjualan', 'no_nota', tanggal);
  const { lastInsertRowid: id } = db.prepare(
    `INSERT INTO penjualan (no_nota,tanggal,kanal,pelanggan_id,pesanan_id,ref_luar,metode_bayar,
                            bruto,komisi,netto,hpp,uang_diterima,kembalian)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`
  ).run(noNota, tanggal, kanal, data.pelanggan_id || null, data.pesanan_id || null,
        data.ref_luar || null, metode, bruto, komisi, netto,
        uangDiterima, metode === 'tunai' ? uangDiterima - bruto : 0);

  const insDetail = db.prepare('INSERT INTO penjualan_detail (penjualan_id,produk_id,qty,harga,subtotal) VALUES (?,?,?,?,?)');
  let totalHpp = 0;

  for (const i of items) {
    const qty = num(i.qty);
    const harga = num(i.harga);
    insDetail.run(id, i.produk_id, qty, harga, qty * harga);

    const s = stok('produk', i.produk_id);
    const hppSatuan = s.qty > 0 ? s.nilai / s.qty : 0;
    const nilai = qty * hppSatuan;
    totalHpp += nilai;

    insMutasiStok.run({
      tanggal, item_tipe: 'produk', item_id: i.produk_id, qty: -qty, nilai: -nilai,
      ref_tipe: 'penjualan', ref_id: id, keterangan: `Terjual ${noNota}`,
    });
  }
  db.prepare('UPDATE penjualan SET hpp = ? WHERE id = ?').run(totalHpp, id);

  // Grab tidak membayar tunai saat transaksi: netto menjadi PIUTANG ke GrabMerchant
  // dan baru masuk kas lewat menu Pencairan Grab. Kanal lain langsung menambah kas.
  if (kanal !== 'grab') {
    insMutasiKas.run({
      tanggal, tipe: 'masuk', kategori: 'penjualan',
      keterangan: `Penjualan ${kanal} ${noNota}`,
      jumlah: netto, ref_tipe: 'penjualan', ref_id: id,
    });
  }

  if (data.pesanan_id) {
    db.prepare("UPDATE pesanan SET status='selesai' WHERE id=?").run(data.pesanan_id);
  }
  return { id, no_nota: noNota, bruto, komisi, netto, kembalian: metode === 'tunai' ? uangDiterima - bruto : 0 };
});

// ---------- PIUTANG GRAB ----------
// Saldo GrabMerchant yang belum dicairkan. Diturunkan dari transaksi, bukan kolom tersimpan.
function piutangGrab(sampai) {
  const b = sampai || '9999-12-31';
  const jual = db.prepare(
    "SELECT COALESCE(SUM(netto),0) s FROM penjualan WHERE kanal='grab' AND tanggal <= ?").get(b).s;
  const cair = db.prepare(
    'SELECT COALESCE(SUM(jumlah),0) s FROM pencairan_grab WHERE tanggal <= ?').get(b).s;
  return { terkumpul: jual, dicairkan: cair, saldo: jual - cair };
}

const simpanPencairanGrab = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const jumlah = num(data.jumlah);
  if (jumlah <= 0) throw new Error('Nominal pencairan harus lebih dari nol.');

  const p = piutangGrab(tanggal);
  if (jumlah > p.saldo + 0.01) {
    const maks = Math.round(p.saldo).toLocaleString('id-ID');
    throw new Error('Pencairan melebihi saldo Grab yang tersedia (maksimal Rp ' + maks + ').');
  }

  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO pencairan_grab (tanggal,jumlah,keterangan) VALUES (?,?,?)'
  ).run(tanggal, jumlah, data.keterangan || null);

  insMutasiKas.run({
    tanggal, tipe: 'masuk', kategori: 'pencairan_grab',
    keterangan: data.keterangan || 'Pencairan saldo GrabMerchant',
    jumlah, ref_tipe: 'pencairan_grab', ref_id: id,
  });
  return { id, jumlah, sisa: p.saldo - jumlah };
});

// ---------- PRIVE, WASTE, STOCK OPNAME ----------

// Pengambilan pribadi pemilik. Mengurangi kas DAN ekuitas — bukan beban usaha,
// jadi tidak boleh ikut mengurangi laba.
const simpanPrive = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const jumlah = num(data.jumlah);
  if (jumlah <= 0) throw new Error('Nominal prive harus lebih dari nol.');

  const kas = db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END),0) s FROM mutasi_kas").get().s;
  if (jumlah > kas) {
    throw new Error('Prive melebihi saldo kas (tersedia Rp ' + Math.round(kas).toLocaleString('id-ID') + ').');
  }

  insMutasiKas.run({
    tanggal, tipe: 'keluar', kategori: 'prive',
    keterangan: data.keterangan || 'Pengambilan pribadi pemilik',
    jumlah, ref_tipe: 'prive', ref_id: null,
  });
  return { jumlah, sisaKas: kas - jumlah };
});

// Harga rata-rata satu item, dipakai untuk menilai waste & selisih opname.
function hargaRataItem(tipe, id) {
  const s = stok(tipe, id);
  if (s.qty > 0) return s.nilai / s.qty;
  const t = tipe === 'bahan'
    ? db.prepare('SELECT harga_avg h FROM bahan WHERE id=?').get(id)
    : db.prepare('SELECT hpp_avg h FROM produk WHERE id=?').get(id);
  return t ? t.h : 0;
}

function namaItem(tipe, id) {
  const t = tipe === 'bahan'
    ? db.prepare('SELECT nama, satuan FROM bahan WHERE id=?').get(id)
    : db.prepare('SELECT nama, satuan FROM produk WHERE id=?').get(id);
  return t || { nama: '?', satuan: '' };
}

// Produk tidak laku / bahan rusak dibuang. Stok berkurang dan nilainya
// langsung diakui sebagai kerugian pada laporan laba rugi.
const simpanWaste = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const tipe = data.item_tipe === 'bahan' ? 'bahan' : 'produk';
  const id = Number(data.item_id);
  const qty = num(data.qty);
  if (!id) throw new Error('Item yang dibuang belum dipilih.');
  if (qty <= 0) throw new Error('Jumlah yang dibuang harus lebih dari nol.');

  const s = stok(tipe, id);
  const it = namaItem(tipe, id);
  if (s.qty < qty) {
    throw new Error(`Stok ${it.nama} tidak cukup: tersedia ${s.qty} ${it.satuan}, dibuang ${qty}.`);
  }

  const nilai = qty * hargaRataItem(tipe, id);
  insMutasiStok.run({
    tanggal, item_tipe: tipe, item_id: id, qty: -qty, nilai: -nilai,
    ref_tipe: 'waste', ref_id: null,
    keterangan: 'Dibuang — ' + (data.alasan || 'tidak laku'),
  });
  return { nama: it.nama, satuan: it.satuan, qty, nilai };
});

// Stock opname: menyamakan catatan dengan hitungan fisik.
// Selisihnya diakui sebagai kerugian (kurang) atau keuntungan (lebih).
const simpanOpname = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const tipe = data.item_tipe === 'produk' ? 'produk' : 'bahan';
  const id = Number(data.item_id);
  const fisik = num(data.qty_fisik, -1);
  if (!id) throw new Error('Item belum dipilih.');
  if (fisik < 0) throw new Error('Jumlah hasil hitung fisik belum diisi.');

  const s = stok(tipe, id);
  const selisih = fisik - s.qty;
  const it = namaItem(tipe, id);
  if (Math.abs(selisih) < 0.0001) {
    return { nama: it.nama, satuan: it.satuan, sistem: s.qty, fisik, selisih: 0, nilai: 0 };
  }

  const nilai = selisih * hargaRataItem(tipe, id);
  insMutasiStok.run({
    tanggal, item_tipe: tipe, item_id: id, qty: selisih, nilai,
    ref_tipe: 'opname', ref_id: null,
    keterangan: `Stock opname: sistem ${s.qty} → fisik ${fisik}` + (data.alasan ? ' — ' + data.alasan : ''),
  });
  return { nama: it.nama, satuan: it.satuan, sistem: s.qty, fisik, selisih, nilai };
});

// Rekap waste & selisih opname untuk laporan laba rugi
function penyesuaianPersediaan(dari, sampai) {
  const q = db.prepare(`
    SELECT COALESCE(SUM(nilai),0) s FROM mutasi_stok
     WHERE ref_tipe = ? AND tanggal BETWEEN ? AND ?`);
  const waste = q.get('waste', dari, sampai).s;    // negatif = rugi
  const opname = q.get('opname', dari, sampai).s;  // negatif = kurang, positif = lebih
  return { waste, opname, total: waste + opname };
}

function riwayatPenyesuaian(batas = 30) {
  return db.prepare(`
    SELECT m.*,
           CASE m.item_tipe WHEN 'bahan'
             THEN (SELECT nama FROM bahan  WHERE id = m.item_id)
             ELSE (SELECT nama FROM produk WHERE id = m.item_id) END  AS nama,
           CASE m.item_tipe WHEN 'bahan'
             THEN (SELECT satuan FROM bahan  WHERE id = m.item_id)
             ELSE (SELECT satuan FROM produk WHERE id = m.item_id) END AS satuan
      FROM mutasi_stok m
     WHERE m.ref_tipe IN ('waste','opname')
     ORDER BY m.id DESC LIMIT ?`).all(batas);
}

// ---------- BIAYA & MODAL ----------
const simpanBiaya = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const jumlah = num(data.jumlah);
  if (jumlah <= 0) throw new Error('Nominal biaya harus lebih dari nol.');
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO biaya (tanggal,kategori,keterangan,jumlah) VALUES (?,?,?,?)'
  ).run(tanggal, data.kategori || 'lain-lain', data.keterangan || '-', jumlah);
  insMutasiKas.run({
    tanggal, tipe: 'keluar', kategori: 'biaya', keterangan: data.keterangan || 'Biaya operasional',
    jumlah, ref_tipe: 'biaya', ref_id: id,
  });
  return { id };
});

const simpanModal = db.transaction((data) => {
  const tanggal = data.tanggal || hariIni();
  const jumlah = num(data.jumlah);
  if (jumlah <= 0) throw new Error('Nominal modal harus lebih dari nol.');
  insMutasiKas.run({
    tanggal, tipe: 'masuk', kategori: 'modal',
    keterangan: data.keterangan || 'Setoran modal pemilik', jumlah, ref_tipe: 'modal', ref_id: null,
  });
  return { jumlah };
});

// ---------- LAPORAN ----------
function rentang(dari, sampai) {
  return { dari: dari || hariIni(), sampai: sampai || dari || hariIni() };
}

function laporanPenjualan(dari, sampai) {
  const r = rentang(dari, sampai);
  const rincian = db.prepare(`
    SELECT p.nama, d.harga, SUM(d.qty) qty, SUM(d.subtotal) subtotal
      FROM penjualan_detail d
      JOIN penjualan j ON j.id = d.penjualan_id
      JOIN produk p    ON p.id = d.produk_id
     WHERE j.tanggal BETWEEN ? AND ?
     GROUP BY d.produk_id, d.harga ORDER BY subtotal DESC`).all(r.dari, r.sampai);

  const perKanal = db.prepare(`
    SELECT kanal, COUNT(*) nota, SUM(bruto) bruto, SUM(komisi) komisi, SUM(netto) netto
      FROM penjualan WHERE tanggal BETWEEN ? AND ? GROUP BY kanal`).all(r.dari, r.sampai);

  const total = db.prepare(`
    SELECT COALESCE(SUM(bruto),0) bruto, COALESCE(SUM(komisi),0) komisi,
           COALESCE(SUM(netto),0) netto, COALESCE(SUM(hpp),0) hpp, COUNT(*) nota
      FROM penjualan WHERE tanggal BETWEEN ? AND ?`).get(r.dari, r.sampai);

  const totalQty = rincian.reduce((s, x) => s + x.qty, 0);
  return { ...r, rincian, perKanal, total, totalQty, terlaris: rincian[0] || null };
}

function laporanPembelianProduksi(dari, sampai) {
  const r = rentang(dari, sampai);
  const bahan = db.prepare(`
    SELECT b.id, b.nama, b.satuan,
      COALESCE((SELECT SUM(qty)   FROM mutasi_stok WHERE item_tipe='bahan' AND item_id=b.id AND tanggal < ?),0) stok_awal,
      COALESCE((SELECT SUM(qty)   FROM mutasi_stok WHERE item_tipe='bahan' AND item_id=b.id AND ref_tipe='pembelian' AND tanggal BETWEEN ? AND ?),0) masuk,
      COALESCE((SELECT SUM(nilai) FROM mutasi_stok WHERE item_tipe='bahan' AND item_id=b.id AND ref_tipe='pembelian' AND tanggal BETWEEN ? AND ?),0) nilai_beli,
      COALESCE((SELECT -SUM(qty)  FROM mutasi_stok WHERE item_tipe='bahan' AND item_id=b.id AND ref_tipe='produksi' AND tanggal BETWEEN ? AND ?),0) dipakai,
      COALESCE((SELECT SUM(qty)   FROM mutasi_stok WHERE item_tipe='bahan' AND item_id=b.id AND tanggal <= ?),0) stok_akhir
    FROM bahan b WHERE b.aktif=1 ORDER BY b.nama`)
    .all(r.dari, r.dari, r.sampai, r.dari, r.sampai, r.dari, r.sampai, r.sampai);

  const batch = db.prepare(`
    SELECT pr.no_batch, pr.tanggal, pr.total_nilai_bahan,
           (SELECT GROUP_CONCAT(p.nama || ' (' || CAST(ph.qty AS INT) || ')', ', ')
              FROM produksi_hasil ph JOIN produk p ON p.id=ph.produk_id WHERE ph.produksi_id=pr.id) hasil,
           (SELECT GROUP_CONCAT(b.nama || ' ' || CAST(pb.qty AS INT) || ' ' || b.satuan, ', ')
              FROM produksi_bahan pb JOIN bahan b ON b.id=pb.bahan_id WHERE pb.produksi_id=pr.id) bahan,
           (SELECT COALESCE(SUM(qty),0) FROM produksi_hasil WHERE produksi_id=pr.id) total_output
      FROM produksi pr WHERE pr.tanggal BETWEEN ? AND ? ORDER BY pr.tanggal, pr.id`).all(r.dari, r.sampai);

  const totalBelanja = db.prepare(
    'SELECT COALESCE(SUM(total),0) t FROM pembelian WHERE tanggal BETWEEN ? AND ?').get(r.dari, r.sampai).t;
  const totalOutput = batch.reduce((s, b) => s + b.total_output, 0);

  return { ...r, bahan, batch, totalBelanja, totalOutput };
}

function bukuKas(dari, sampai) {
  const r = rentang(dari, sampai);
  const saldoAwal = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END),0) s
      FROM mutasi_kas WHERE tanggal < ?`).get(r.dari).s;
  const mutasi = db.prepare(
    'SELECT * FROM mutasi_kas WHERE tanggal BETWEEN ? AND ? ORDER BY tanggal, id').all(r.dari, r.sampai);
  const masuk = mutasi.filter((m) => m.tipe === 'masuk').reduce((s, m) => s + m.jumlah, 0);
  const keluar = mutasi.filter((m) => m.tipe === 'keluar').reduce((s, m) => s + m.jumlah, 0);
  return { ...r, saldoAwal, mutasi, masuk, keluar, saldoAkhir: saldoAwal + masuk - keluar };
}

function laporanKeuangan(dari, sampai) {
  const r = rentang(dari, sampai);
  const jual = db.prepare(`
    SELECT COALESCE(SUM(bruto),0) bruto, COALESCE(SUM(komisi),0) komisi,
           COALESCE(SUM(netto),0) netto, COALESCE(SUM(hpp),0) hpp
      FROM penjualan WHERE tanggal BETWEEN ? AND ?`).get(r.dari, r.sampai);

  const bebanRows = db.prepare(`
    SELECT kategori, SUM(jumlah) jumlah FROM biaya
     WHERE tanggal BETWEEN ? AND ? GROUP BY kategori ORDER BY jumlah DESC`).all(r.dari, r.sampai);
  const totalBeban = bebanRows.reduce((s, b) => s + b.jumlah, 0);

  const labaKotor = jual.netto - jual.hpp;
  // waste & selisih opname bernilai negatif saat merugikan, jadi ditambahkan apa adanya
  const penyesuaian = penyesuaianPersediaan(r.dari, r.sampai);
  const labaBersih = labaKotor - totalBeban + penyesuaian.total;

  // --- Neraca per tanggal `sampai` (posisi kumulatif) ---
  const kas = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END),0) s
      FROM mutasi_kas WHERE tanggal <= ?`).get(r.sampai).s;
  const persBahan = db.prepare(`
    SELECT COALESCE(SUM(nilai),0) s FROM mutasi_stok
     WHERE item_tipe='bahan' AND tanggal <= ?`).get(r.sampai).s;
  const persProduk = db.prepare(`
    SELECT COALESCE(SUM(nilai),0) s FROM mutasi_stok
     WHERE item_tipe='produk' AND tanggal <= ?`).get(r.sampai).s;
  const utang = db.prepare(`
    SELECT COALESCE(SUM(total),0) s FROM pembelian
     WHERE cara_bayar='utang' AND tanggal <= ?`).get(r.sampai).s;
  // Modal & prive diturunkan dari mutasi kas, bukan disimpan terpisah
  const qKas = db.prepare(`
    SELECT COALESCE(SUM(jumlah),0) s FROM mutasi_kas
     WHERE kategori = ? AND tipe = ? AND tanggal <= ?`);
  const modal = qKas.get('modal', 'masuk', r.sampai).s;
  const prive = qKas.get('prive', 'keluar', r.sampai).s;

  // Laba ditahan dihitung MANDIRI dari akumulasi transaksi sejak awal, bukan sebagai
  // angka penyeimbang. Dengan begitu status "seimbang" di bawah benar-benar menguji
  // konsistensi data, bukan sekadar tautologi.
  const kum = db.prepare(`
    SELECT COALESCE(SUM(netto),0) netto, COALESCE(SUM(hpp),0) hpp
      FROM penjualan WHERE tanggal <= ?`).get(r.sampai);
  const biayaKum = db.prepare(
    "SELECT COALESCE(SUM(jumlah),0) s FROM biaya WHERE tanggal <= ?").get(r.sampai).s;
  const penyKum = penyesuaianPersediaan('0000-01-01', r.sampai);
  const labaDitahan = kum.netto - kum.hpp - biayaKum + penyKum.total;

  const piutang = piutangGrab(r.sampai).saldo;
  const totalAset  = kas + piutang + persBahan + persProduk;
  const ekuitas    = modal - prive + labaDitahan;
  const totalPasiva = utang + ekuitas;

  return {
    ...r,
    labaRugi: { ...jual, bebanRows, totalBeban, penyesuaian, labaKotor, labaBersih },
    neraca: { kas, piutang, persBahan, persProduk, totalAset,
              utang, modal, prive, labaDitahan, ekuitas, totalPasiva,
              seimbang: Math.abs(totalAset - totalPasiva) < 1 },
  };
}

function ringkasanDashboard() {
  const t = hariIni();
  const jual = db.prepare(
    `SELECT COALESCE(SUM(bruto),0) bruto, COALESCE(SUM(netto),0) netto,
            COALESCE(SUM(hpp),0) hpp, COUNT(*) nota FROM penjualan WHERE tanggal=?`).get(t);
  const qty = db.prepare(`SELECT COALESCE(SUM(d.qty),0) q FROM penjualan_detail d
                            JOIN penjualan j ON j.id=d.penjualan_id WHERE j.tanggal=?`).get(t).q;
  const kas = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN tipe='masuk' THEN jumlah ELSE -jumlah END),0) s FROM mutasi_kas`).get().s;
  const pesananBaru = db.prepare("SELECT COUNT(*) c FROM pesanan WHERE status='baru'").get().c;
  const piutang = piutangGrab().saldo;
  const bahanMenipis = daftarBahanDenganStok().filter((b) => b.stok_min > 0 && b.stok <= b.stok_min);
  const produk = daftarProdukDenganStok('retail');
  return { tanggal: t, jual, qty, kas, piutang, pesananBaru, bahanMenipis, produk };
}

module.exports = {
  db, hariIni, num, stok, pengaturan, setPengaturan,
  daftarBahanDenganStok, daftarProdukDenganStok, kebutuhanDariResep,
  simpanPembelian, simpanProduksi, simpanPesanan, simpanPenjualan, simpanBiaya, simpanModal,
  piutangGrab, simpanPencairanGrab,
  simpanPrive, simpanWaste, simpanOpname, penyesuaianPersediaan, riwayatPenyesuaian, hargaRataItem,
  laporanPenjualan, laporanPembelianProduksi, bukuKas, laporanKeuangan, ringkasanDashboard,
};
