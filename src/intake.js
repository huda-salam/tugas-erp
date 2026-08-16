// Lapisan penerimaan pesanan dari kanal luar (WhatsApp / GrabFood).
//
// Simulator di /simulasi hanyalah salah satu klien dari modul ini. Endpoint yang
// dipanggilnya sama persis dengan yang nanti dipanggil webhook asli, jadi mengganti
// simulator dengan integrasi sungguhan tidak menyentuh inti aplikasi.
const db = require('./db');
const S = require('./services');

const rupiah = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

// ---------- pencatatan pesan mentah ----------
const qPesanLama = db.prepare('SELECT * FROM pesan_masuk WHERE sumber = ? AND ref_luar = ?');
const qCatatPesan = db.prepare(`
  INSERT INTO pesan_masuk (sumber, ref_luar, pengirim, isi_mentah, payload, status, pesanan_id, catatan_parser)
  VALUES (@sumber, @ref_luar, @pengirim, @isi_mentah, @payload, @status, @pesanan_id, @catatan_parser)`);
const qUbahPesan = db.prepare(
  'UPDATE pesan_masuk SET status = ?, pesanan_id = ?, catatan_parser = ? WHERE id = ?');

// ---------- parser teks bebas WhatsApp ----------
const rapikan = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Kata yang tidak membantu membedakan produk, dibuang agar skor tidak melar
const KATA_ABAI = new Set(['pesan', 'pesen', 'mau', 'minta', 'beli', 'porsi', 'buah', 'pcs',
  'bungkus', 'cup', 'yg', 'yang', 'dan', 'sama', 'tolong', 'ya', 'dong', 'kak', 'bu', 'pak']);

function cocokkanProduk(teks, daftar) {
  const token = rapikan(teks).split(' ').filter((t) => t && !KATA_ABAI.has(t));
  if (!token.length) return null;

  let terbaik = null;
  let skorTerbaik = 0;
  for (const p of daftar) {
    const nama = rapikan(p.nama);
    const cocok = token.filter((t) => nama.includes(t)).length;
    const skor = cocok / token.length;
    if (skor > skorTerbaik) { skorTerbaik = skor; terbaik = p; }
  }
  // minimal separuh kata harus ketemu, supaya "nasi goreng" tidak dipaksa cocok
  return skorTerbaik >= 0.5 ? terbaik : null;
}

// "2 bubur beras merah, 1 pisang susu" / "bubur beras merah x2"
function bacaPesananWA(teks) {
  const daftar = S.daftarProdukDenganStok('pesanan');
  const potongan = (teks || '')
    .split(/[\n,;]+|\s+dan\s+|\s+\+\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);

  const items = [];
  const tidakDikenali = [];

  for (const bagian of potongan) {
    let qty = 1;
    let namaBagian = bagian;

    const depan = bagian.match(/^(\d+)\s*(?:x|buah|porsi|pcs|bungkus|cup)?\s*(.+)$/i);
    const belakang = bagian.match(/^(.+?)\s*(?:x|\*)\s*(\d+)$/i);
    if (depan) { qty = parseInt(depan[1], 10); namaBagian = depan[2]; }
    else if (belakang) { namaBagian = belakang[1]; qty = parseInt(belakang[2], 10); }

    if (!(qty > 0)) { tidakDikenali.push(bagian); continue; }

    const produk = cocokkanProduk(namaBagian, daftar);
    if (!produk) { tidakDikenali.push(bagian); continue; }

    const sudah = items.find((i) => i.produk_id === produk.id);
    if (sudah) sudah.qty += qty;
    else items.push({ produk_id: produk.id, nama: produk.nama, qty, harga: produk.harga, stok: produk.stok });
  }

  for (const i of items) i.subtotal = i.qty * i.harga;
  return {
    items,
    tidakDikenali,
    total: items.reduce((s, i) => s + i.subtotal, 0),
    yakin: items.length > 0 && tidakDikenali.length === 0,
  };
}

// ---------- pelanggan berdasarkan nomor WhatsApp ----------
function pelangganDariNomor(nomor) {
  if (!nomor) return null;
  const ada = db.prepare('SELECT id FROM pelanggan WHERE telp = ?').get(nomor);
  if (ada) return ada.id;
  return db.prepare('INSERT INTO pelanggan (nama, telp) VALUES (?,?)')
    .run('WA ' + nomor, nomor).lastInsertRowid;
}

// ---------- WhatsApp ----------
const qSesi = db.prepare('SELECT * FROM wa_sesi WHERE pengirim = ?');
const qSimpanSesi = db.prepare(`INSERT INTO wa_sesi (pengirim, draft) VALUES (?,?)
  ON CONFLICT(pengirim) DO UPDATE SET draft = excluded.draft, dibuat_pada = datetime('now','localtime')`);
const qHapusSesi = db.prepare('DELETE FROM wa_sesi WHERE pengirim = ?');

const YA = /^(ya|y|ok|oke|okay|yes|betul|benar|setuju|lanjut)$/i;
const BATAL = /^(batal|cancel|tidak|no|gak|nggak)$/i;

const terimaWhatsApp = db.transaction((data) => {
  const pengirim = (data.pengirim || '').trim();
  const teks = (data.teks || '').trim();
  const ref = (data.ref_luar || '').trim();
  if (!pengirim) throw new Error('Nomor pengirim wajib diisi.');
  if (!teks) throw new Error('Isi pesan kosong.');
  if (!ref) throw new Error('ref_luar (id pesan) wajib diisi.');

  // idempotensi: pesan dengan id yang sama tidak diproses dua kali
  const lama = qPesanLama.get('whatsapp', ref);
  if (lama) {
    return {
      duplikat: true,
      balasan: lama.catatan_parser || 'Pesan ini sudah pernah diproses.',
      pesanan_id: lama.pesanan_id,
    };
  }

  const pesanId = qCatatPesan.run({
    sumber: 'whatsapp', ref_luar: ref, pengirim, isi_mentah: teks,
    payload: JSON.stringify(data), status: 'diproses', pesanan_id: null, catatan_parser: null,
  }).lastInsertRowid;

  const selesai = (balasan, status, pesananId = null) => {
    qUbahPesan.run(status, pesananId, balasan, pesanId);
    return { duplikat: false, balasan, pesanan_id: pesananId };
  };

  const sesi = qSesi.get(pengirim);

  // 1. konfirmasi
  if (YA.test(teks)) {
    if (!sesi) return selesai('Belum ada pesanan yang menunggu konfirmasi. Silakan ketik pesanan Anda 🙏', 'draft');
    const draft = JSON.parse(sesi.draft);
    const r = S.simpanPesanan({
      tanggal: S.hariIni(), tanggal_kirim: S.hariIni(),
      pelanggan_id: pelangganDariNomor(pengirim),
      kanal: 'pesanan', sumber: 'whatsapp', ref_luar: 'WA ' + pengirim,
      catatan: 'Pesanan via WhatsApp',
      items: draft.items.map((i) => ({ produk_id: i.produk_id, qty: i.qty, harga: i.harga })),
    });
    qHapusSesi.run(pengirim);
    return selesai(
      `✅ Pesanan dikonfirmasi!\n\nNomor: ${r.no_pesanan}\nTotal: ${rupiah(r.total)}\n\n` +
      'Pesanan Anda sudah masuk antrean dapur. Terima kasih 🙏', 'diproses', r.id);
  }

  // 2. pembatalan
  if (BATAL.test(teks)) {
    if (sesi) qHapusSesi.run(pengirim);
    return selesai('Baik, pesanan dibatalkan. Silakan pesan lagi kapan saja 🙏', 'draft');
  }

  // 3. pesanan baru
  const hasil = bacaPesananWA(teks);
  if (!hasil.items.length) {
    return selesai(
      'Maaf, kami belum bisa membaca pesanan Anda 🙏\n\n' +
      'Contoh format:\n*2 bubur beras merah, 1 pisang susu*\n\n' +
      'Menu tersedia:\n' +
      S.daftarProdukDenganStok('pesanan').map((p) => `• ${p.nama} — ${rupiah(p.harga)}`).join('\n'),
      'gagal');
  }

  qSimpanSesi.run(pengirim, JSON.stringify(hasil));

  let balasan = 'Terima kasih! Kami baca pesanan Anda:\n\n';
  balasan += hasil.items.map((i) => `${i.qty}x ${i.nama} — ${rupiah(i.subtotal)}`).join('\n');
  balasan += `\n\n*Total: ${rupiah(hasil.total)}*`;
  if (hasil.tidakDikenali.length) {
    balasan += `\n\n⚠️ Tidak dikenali: "${hasil.tidakDikenali.join('", "')}" — bagian ini tidak kami hitung.`;
  }
  const kurang = hasil.items.filter((i) => i.qty > i.stok);
  if (kurang.length) {
    balasan += `\n\nℹ️ Stok siap sekarang terbatas untuk ${kurang.map((k) => k.nama).join(', ')}, ` +
               'akan kami masakkan lebih dulu.';
  }
  balasan += '\n\nKetik *YA* untuk konfirmasi, atau *BATAL* untuk membatalkan.';

  return selesai(balasan, 'draft');
});

// ---------- GrabFood ----------
// Payload sudah terstruktur, jadi tidak ada parsing — hanya pemetaan kode item.
const terimaGrab = db.transaction((data) => {
  const orderId = (data.order_id || '').trim();
  const driver = (data.driver || '').trim();
  const items = Array.isArray(data.items) ? data.items : [];
  if (!orderId) throw new Error('order_id wajib diisi.');
  if (!items.length) throw new Error('Order tidak berisi item.');

  const lama = qPesanLama.get('grab', orderId);
  if (lama) {
    return { duplikat: true, pesanan_id: lama.pesanan_id, pesan: `Order ${orderId} sudah pernah diterima.` };
  }

  const pesanId = qCatatPesan.run({
    sumber: 'grab', ref_luar: orderId, pengirim: driver || null,
    isi_mentah: null, payload: JSON.stringify(data),
    status: 'diproses', pesanan_id: null, catatan_parser: null,
  }).lastInsertRowid;

  const qKode = db.prepare(`
    SELECT r.produk_id, p.nama, COALESCE(h.harga,0) harga
      FROM produk_kanal_ref r
      JOIN produk p ON p.id = r.produk_id
      LEFT JOIN produk_harga h ON h.produk_id = r.produk_id AND h.kanal = 'grab'
     WHERE r.kanal = 'grab' AND r.kode_luar = ?`);

  const baris = [];
  const takDikenal = [];
  for (const it of items) {
    const qty = S.num(it.qty);
    const ref = qKode.get(String(it.kode || '').trim());
    if (!ref || qty <= 0) { takDikenal.push(it.kode); continue; }
    baris.push({ produk_id: ref.produk_id, nama: ref.nama, qty, harga: ref.harga });
  }

  if (takDikenal.length) {
    // Sengaja TIDAK melempar Error: throw akan me-rollback transaksi berikut baris
    // pesan_masuk-nya, sehingga kiriman gagal tidak meninggalkan jejak untuk ditelusuri.
    const pesan = `Kode item tidak dikenal: ${takDikenal.join(', ')}. Daftarkan dulu di produk_kanal_ref.`;
    qUbahPesan.run('gagal', null, pesan, pesanId);
    return { gagal: true, duplikat: false, pesanan_id: null, pesan };
  }

  const r = S.simpanPesanan({
    tanggal: S.hariIni(), pelanggan_id: null,
    kanal: 'grab', sumber: 'grab',
    ref_luar: orderId + (driver ? ' · ' + driver : ''),
    catatan: data.catatan || null,
    items: baris.map((b) => ({ produk_id: b.produk_id, qty: b.qty, harga: b.harga })),
  });

  qUbahPesan.run('diproses', r.id, `Order ${orderId} → ${r.no_pesanan}`, pesanId);
  return {
    duplikat: false, pesanan_id: r.id, no_pesanan: r.no_pesanan, total: r.total, items: baris,
    pesan: `Order ${orderId} diterima sebagai ${r.no_pesanan} (${rupiah(r.total)}).`,
  };
});

function daftarPesanMasuk(batas = 30) {
  return db.prepare(`
    SELECT m.*, p.no_pesanan
      FROM pesan_masuk m LEFT JOIN pesanan p ON p.id = m.pesanan_id
     ORDER BY m.id DESC LIMIT ?`).all(batas);
}

module.exports = { bacaPesananWA, terimaWhatsApp, terimaGrab, daftarPesanMasuk };
