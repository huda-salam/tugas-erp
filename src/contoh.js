// Data contoh untuk usaha bubur bayi.
//
// Dipisah dari seed.js supaya bisa dipanggil dua arah: lewat CLI (npm run seed) dan
// lewat wizard penyiapan di layar, ketika pengguna memilih "isi data contoh".
// Transaksi contoh dibuat lewat service yang sama dengan aplikasi, jadi angkanya
// dijamin konsisten dan neraca tetap seimbang.
const db = require('./db');
const S = require('./services');

// Kosongkan seluruh data usaha. sqlite_sequence ikut dihapus supaya id mulai dari 1
// lagi — kalau tidak, referensi id di data contoh jadi meleset.
function kosongkan() {
    db.exec(`DELETE FROM mutasi_stok; DELETE FROM mutasi_kas; DELETE FROM biaya;
             DELETE FROM pencairan_grab;
             DELETE FROM pesan_masuk; DELETE FROM wa_sesi; DELETE FROM produk_kanal_ref;
             DELETE FROM penjualan_detail; DELETE FROM penjualan;
             DELETE FROM pesanan_detail;   DELETE FROM pesanan;
             DELETE FROM produksi_hasil;   DELETE FROM produksi_bahan; DELETE FROM produksi;
             DELETE FROM pembelian_detail; DELETE FROM pembelian;
             DELETE FROM resep; DELETE FROM produk_harga; DELETE FROM produk;
             DELETE FROM bahan; DELETE FROM supplier; DELETE FROM pelanggan; DELETE FROM pengaturan;
                      DELETE FROM sesi; DELETE FROM pengguna;
           DELETE FROM sqlite_sequence;`);
}

const adaMaster = () => db.prepare('SELECT COUNT(*) c FROM produk').get().c > 0;

// Master: produk, bahan, resep, supplier, pelanggan, pemetaan kode GrabFood.
function isiMasterContoh() {
  S.setPengaturan('nama_usaha', 'Bubur Bayi Procil');
  S.setPengaturan('komisi_grab_persen', '20');
  S.setPengaturan('modal_disetor', '0');

  const insSup = db.prepare('INSERT INTO supplier (nama,telp) VALUES (?,?)');
  const supplierId = {};
  ['Sinar Tani Grosir', 'Toko Buah Segar', 'CV Kemasan Plastik']
    .forEach((n) => { supplierId[n] = insSup.run(n, null).lastInsertRowid; });

  const insPel = db.prepare('INSERT INTO pelanggan (nama,telp) VALUES (?,?)');
  const pelangganId = {};
  [['Ibu Linda', '0812-1111-2222'], ['Bapak Rahmat (Catering)', '0813-3333-4444'],
   ['Posyandu Melati', '0857-5555-6666']]
    .forEach(([n, t]) => { pelangganId[n] = insPel.run(n, t).lastInsertRowid; });

  // satuan sengaja kecil (gram/ml) supaya pemakaian di resep akurat
  const insBahan = db.prepare('INSERT INTO bahan (nama,satuan,stok_min) VALUES (?,?,?)');
  const bahanId = {};
  [
    ['Beras Merah Organik', 'gram', 2000],
    ['Beras Putih', 'gram', 2000],
    ['Pisang Ambon', 'gram', 1000],
    ['Wortel Segar', 'gram', 1000],
    ['Santan / Susu Cair', 'ml', 1000],
    ['Gula Aren', 'gram', 500],
    ['Cup Kemasan 150ml', 'pcs', 50],
  ].forEach(([n, s, m]) => { bahanId[n] = insBahan.run(n, s, m).lastInsertRowid; });

  const insProduk = db.prepare('INSERT INTO produk (nama,satuan) VALUES (?,?)');
  const insHarga = db.prepare('INSERT INTO produk_harga (produk_id,kanal,harga) VALUES (?,?,?)');
  const produkId = {};
  [
    ['Bubur Bayi Beras Merah', 5000, 4800, 6500],
    ['Bubur Bayi Pisang Susu', 5000, 4800, 6500],
    ['Puree Wortel Organik', 6000, 5800, 7500],
  ].forEach(([n, r, p, g]) => {
    const id = insProduk.run(n, 'porsi').lastInsertRowid;
    produkId[n] = id;
    insHarga.run(id, 'retail', r); insHarga.run(id, 'pesanan', p); insHarga.run(id, 'grab', g);
  });

  // Resep per 1 porsi
  const insResep = db.prepare('INSERT INTO resep (produk_id,bahan_id,qty) VALUES (?,?,?)');
  const resep = {
    'Bubur Bayi Beras Merah': [['Beras Merah Organik', 40], ['Santan / Susu Cair', 30], ['Gula Aren', 8], ['Cup Kemasan 150ml', 1]],
    'Bubur Bayi Pisang Susu': [['Beras Putih', 35], ['Pisang Ambon', 45], ['Santan / Susu Cair', 40], ['Cup Kemasan 150ml', 1]],
    'Puree Wortel Organik':   [['Wortel Segar', 80], ['Santan / Susu Cair', 20], ['Cup Kemasan 150ml', 1]],
  };
  for (const [p, list] of Object.entries(resep)) {
    for (const [b, q] of list) insResep.run(produkId[p], bahanId[b], q);
  }

  // Kode item milik GrabFood. Order dari luar membawa kode miliknya, bukan id kita.
  const insRef = db.prepare('INSERT INTO produk_kanal_ref (produk_id,kanal,kode_luar) VALUES (?,?,?)');
  [['Bubur Bayi Beras Merah', 'BBM'], ['Bubur Bayi Pisang Susu', 'BBPS'], ['Puree Wortel Organik', 'PWO']]
    .forEach(([nama, kode]) => insRef.run(produkId[nama], 'grab', kode));
  return { produkId, bahanId, supplierId, pelangganId };
}

// Satu hari transaksi lengkap: modal, belanja, produksi, pesanan, penjualan,
// biaya, waste, dan prive.
function isiTransaksiContoh({ produkId, bahanId, supplierId, pelangganId }) {
    const t = S.hariIni();
    S.simpanModal({ tanggal: t, jumlah: 500000, keterangan: 'Modal awal usaha' });

    S.simpanPembelian({
      tanggal: t, supplier_id: supplierId['Sinar Tani Grosir'], cara_bayar: 'tunai',
      items: [
        { bahan_id: bahanId['Beras Merah Organik'], qty: 3000, harga_satuan: 18 },
        { bahan_id: bahanId['Beras Putih'], qty: 2000, harga_satuan: 12 },
        { bahan_id: bahanId['Pisang Ambon'], qty: 2000, harga_satuan: 15 },
        { bahan_id: bahanId['Santan / Susu Cair'], qty: 3000, harga_satuan: 8 },
        { bahan_id: bahanId['Gula Aren'], qty: 1000, harga_satuan: 22 },
        { bahan_id: bahanId['Cup Kemasan 150ml'], qty: 200, harga_satuan: 350 },
      ],
    });

    S.simpanProduksi({
      tanggal: t,
      bahan: [
        { bahan_id: bahanId['Beras Merah Organik'], qty: 40 * 45 },
        { bahan_id: bahanId['Santan / Susu Cair'], qty: 30 * 45 },
        { bahan_id: bahanId['Gula Aren'], qty: 8 * 45 },
        { bahan_id: bahanId['Cup Kemasan 150ml'], qty: 45 },
      ],
      hasil: [{ produk_id: produkId['Bubur Bayi Beras Merah'], qty: 45 }],
    });

    S.simpanProduksi({
      tanggal: t,
      bahan: [
        { bahan_id: bahanId['Beras Putih'], qty: 35 * 35 },
        { bahan_id: bahanId['Pisang Ambon'], qty: 45 * 35 },
        { bahan_id: bahanId['Santan / Susu Cair'], qty: 40 * 35 },
        { bahan_id: bahanId['Cup Kemasan 150ml'], qty: 35 },
      ],
      hasil: [{ produk_id: produkId['Bubur Bayi Pisang Susu'], qty: 35 }],
    });

    S.simpanPesanan({
      tanggal: t, tanggal_kirim: t, pelanggan_id: pelangganId['Ibu Linda'],
      items: [
        { produk_id: produkId['Bubur Bayi Beras Merah'], qty: 5, harga: 4800 },
        { produk_id: produkId['Bubur Bayi Pisang Susu'], qty: 5, harga: 4800 },
      ],
    });

    S.simpanPenjualan({
      tanggal: t, kanal: 'retail', metode_bayar: 'tunai', uang_diterima: 150000,
      items: [
        { produk_id: produkId['Bubur Bayi Beras Merah'], qty: 20, harga: 5000 },
        { produk_id: produkId['Bubur Bayi Pisang Susu'], qty: 8, harga: 5000 },
      ],
    });

    // Dua order GrabFood masuk antrean; satu diproses, satu dibiarkan menunggu
    const grabSelesai = S.simpanPesanan({
      tanggal: t, kanal: 'grab', ref_luar: 'GRB-9021 · Ahmad Subarjo',
      items: [{ produk_id: produkId['Bubur Bayi Beras Merah'], qty: 3, harga: 6500 }],
    });
    S.simpanPesanan({
      tanggal: t, kanal: 'grab', ref_luar: 'GRB-9044 · Siti Rahayu',
      items: [
        { produk_id: produkId['Bubur Bayi Beras Merah'], qty: 2, harga: 6500 },
        { produk_id: produkId['Bubur Bayi Pisang Susu'], qty: 1, harga: 6500 },
      ],
    });

    S.simpanPenjualan({
      tanggal: t, kanal: 'grab', pesanan_id: grabSelesai.id, ref_luar: 'GRB-9021 · Ahmad Subarjo',
      items: [{ produk_id: produkId['Bubur Bayi Beras Merah'], qty: 3, harga: 6500 }],
    });

    S.simpanBiaya({ tanggal: t, kategori: 'transportasi', keterangan: 'Bensin antar pesanan', jumlah: 25000 });
    S.simpanBiaya({ tanggal: t, kategori: 'gas & listrik', keterangan: 'Isi ulang gas LPG 3kg', jumlah: 22000 });

    // Sisa jualan sore yang tidak laku, dibuang dan diakui sebagai kerugian
    S.simpanWaste({
      tanggal: t, item_tipe: 'produk', item_id: produkId['Bubur Bayi Pisang Susu'],
      qty: 3, alasan: 'tidak laku / sisa hari ini',
    });

    // Pemilik mengambil uang untuk keperluan pribadi
    S.simpanPrive({ tanggal: t, jumlah: 50000, keterangan: 'Ambil untuk belanja rumah' });

    const k = S.laporanKeuangan(t, t);
}

module.exports = { kosongkan, adaMaster, isiMasterContoh, isiTransaksiContoh };
