# ERP Mini — Bubur Bayi Procil

Aplikasi ERP sederhana untuk UMKM: pembelian bahan, inventory, produksi, pemesanan,
penjualan (retail / pesanan / GrabFood), dan laporan keuangan.

Stack: **Node.js + Express + EJS + SQLite**. Tanpa build step, tanpa server database.

---

## Menjalankan (3 langkah)

```bash
npm install
npm run reset         # isi data contoh + akun bawaan
npm start             # buka http://localhost:3000
```

Login dengan **`pemilik` / `pemilik123`**, lalu ganti sandinya lewat menu Akun.

**Instalasi bersih tanpa data contoh:** cukup `npm install && npm start`. Karena folder
`data/` masih kosong, aplikasi menampilkan **wizard penyiapan** — isi nama usaha, buat
akun pemilik, pilih mau mulai kosong atau dengan data contoh, selesai. Tidak ada
perintah terminal yang perlu dijalankan pemilik usaha.

> **Pakai Node 20 atau lebih baru.** Cek dengan `node -v`.

---

## Akun & hak akses

Dua peran:

| | Pemilik | Kasir |
|---|:---:|:---:|
| Kasir, Pesanan, Stok | ✅ | ✅ |
| Pembelian, Produksi, Penyesuaian | ✅ | — |
| Buku kas, prive, laporan keuangan | ✅ | — |
| Master data & kelola akun | ✅ | — |
| Saldo kas di header | ✅ | disembunyikan |

Pemilik menambah akun kasir lewat **Master Data → Pengguna**, dan bisa menonaktifkan
akun atau menyetel ulang sandinya. Menonaktifkan langsung memutus sesi yang sedang
berjalan, tidak menunggu kedaluwarsa.

Catatan teknis: sandi di-hash dengan **scrypt** bawaan Node (bukan bcrypt, supaya tidak
menambah modul native yang menyulitkan pemasangan di Termux/Android), dan sesi disimpan
di tabel SQLite dengan cookie `HttpOnly; SameSite=Lax` — tanpa dependensi tambahan.
Endpoint `/intake/*` **tidak** memakai sesi melainkan header `X-Intake-Token`, karena
webhook dari luar tidak bisa login.

---

## Daftar perintah

| Perintah | Fungsi |
|---|---|
| `npm start` | Jalankan aplikasi di port 3000 |
| `npm run dev` | Jalankan dengan auto-restart saat file diubah |
| `npm run seed` | Isi master data saja (produk, bahan, resep, supplier, pelanggan) |
| `npm run seed:demo` | Master data + transaksi contoh satu hari |
| `npm run reset` | Hapus semua data & akun, isi ulang dari nol + akun bawaan |
| `npm run rebuild` | Perbaiki `better-sqlite3` kalau error saat install |

Ganti port: `PORT=4000 npm start`

---

## Kalau macet saat install

Satu-satunya paket yang bisa rewel adalah `better-sqlite3`, karena dia native module
(ada bagian C++ yang harus cocok dengan versi Node kamu). Biasanya npm mengunduh
binary jadi dan langsung mulus. Kalau tidak:

```bash
npm run rebuild
```

Masih gagal? Hapus dan pasang ulang:

```bash
rm -rf node_modules package-lock.json
npm install
```

Pengguna Windows yang tetap gagal perlu build tools:
`npm install --global windows-build-tools` (jalankan PowerShell sebagai Administrator).

---

## Aturan kerja kelompok

**Jangan pernah commit folder `data/`.** Sudah masuk `.gitignore`, jangan dikeluarkan.

Database SQLite itu satu file biner. Git tidak bisa menggabungkan dua versi file biner,
jadi kalau dua orang sama-sama input transaksi lalu push, hasilnya bukan gabungan —
yang satu menimpa yang lain dan datanya hilang tanpa peringatan.

Tiap anggota pegang database lokal masing-masing. Kalau butuh data yang seragam
untuk latihan atau presentasi, semua orang jalankan `npm run reset` — bukan saling
kirim file `.sqlite`.

Kalau mengubah struktur tabel, edit `src/schema.sql`, lalu beri tahu tim untuk
menjalankan `npm run reset`. Perubahan skema tidak otomatis berlaku di database
yang sudah terbentuk (skema pakai `CREATE TABLE IF NOT EXISTS`).

---

## Simulasi pemesanan WhatsApp & GrabFood

Buka menu **📱 Simulasi** (tab baru) — ada bingkai ponsel berisi dua aplikasi.
Sandingkan dengan tab **Kasir**: pesanan yang dibuat di simulator muncul di sana
seketika lewat Server-Sent Events, tanpa refresh.

### Terus terang soal batasannya

GrabFood **tidak menyediakan API publik untuk merchant UMKM** — GrabFood Partner API
hanya untuk vendor POS berbadan usaha dengan perjanjian kerja sama. Jadi kanal Grab di
sini memang simulasi, dan tidak ada cara mengubahnya dari sisi kita. WhatsApp punya
jalur resmi (Cloud API), hanya saja butuh akun Meta Business, nomor terverifikasi, dan
tunnel HTTPS publik.

Yang **nyata** adalah lapisan penerimaannya. Simulator bukan fitur, melainkan salah satu
klien yang memanggil endpoint intake:

```
simulator (atau webhook asli) → POST /intake/{whatsapp,grab}
  → dicatat mentah di pesan_masuk → parser/pemetaan → simpanPesanan() → antrean kasir
```

Mengganti simulator dengan integrasi sungguhan cukup mengarahkan webhook ke endpoint
yang sama; inti aplikasi tidak berubah. Endpoint-nya berdiri sendiri:

```bash
# GrabFood — payload terstruktur, kode item dipetakan lewat tabel produk_kanal_ref
curl -X POST http://localhost:3000/intake/grab \
  -H 'X-Intake-Token: procil-dev' -H 'Content-Type: application/json' \
  -d '{"order_id":"GF-7001","driver":"Ahmad","items":[{"kode":"BBM","qty":2}]}'

# WhatsApp — teks bebas, dibaca parser lalu dikonfirmasi pelanggan
curl -X POST http://localhost:3000/intake/whatsapp \
  -H 'X-Intake-Token: procil-dev' -H 'Content-Type: application/json' \
  -d '{"pengirim":"0812-1111-2222","teks":"2 bubur beras merah, 1 pisang susu","ref_luar":"WA-1"}'
```

### Yang sengaja dibuat seperti integrasi sungguhan

- **Idempoten.** `pesan_masuk` punya `UNIQUE(sumber, ref_luar)`. Webhook yang terkirim
  dua kali tidak membuat pesanan kedua — coba tombol "Kirim ulang order terakhir".
- **Semua kiriman dicatat mentah** sebelum diolah, termasuk yang gagal, supaya bisa
  ditelusuri saat parser salah baca.
- **Kode item kanal luar dipetakan** lewat `produk_kanal_ref`, bukan menebak dari nama.
- **Endpoint dilindungi** header `X-Intake-Token` (env `INTAKE_TOKEN`).
- **WhatsApp minta konfirmasi.** Teks bebas dibaca parser, dibalas rincian + total,
  pesanan baru dibuat setelah pelanggan membalas `YA` — seperti praktik UMKM sungguhan.
- **WhatsApp adalah *sumber*, bukan kanal penjualan.** Pesanan WA masuk sebagai PO biasa
  (`kanal='pesanan'`, `sumber='whatsapp'`) sehingga tidak mengacaukan laporan per kanal.

Matikan simulator dengan `SIMULASI=0 npm start`: menu dan halaman `/simulasi` hilang,
endpoint intake tetap hidup karena itu bagian yang nyata.

---

## Struktur folder

```
src/
  server.js      Semua route (Express) + penjaga akses per peran
  auth.js        Akun, sandi (scrypt), sesi
  contoh.js      Data contoh — dipakai CLI seed maupun wizard penyiapan
  services.js    Logika bisnis: stok, HPP, kas, laporan  ← inti aplikasi
  schema.sql     Struktur tabel
  db.js          Koneksi SQLite, jalan otomatis saat boot
  seed.js        Pembungkus CLI untuk contoh.js
views/           Halaman EJS
  partials/      Header & navigasi bersama
public/css/      Satu file CSS untuk semua halaman
desain/          Desain UX asli (referensi, tidak dipakai runtime)
data/            Database lokal — TIDAK di-commit
```

**Kalau mau menambah fitur:** hampir selalu cukup sentuh tiga file —
`services.js` (logikanya), `server.js` (route-nya), dan satu file di `views/`.

---

## Catatan penting soal cara hitung

Beberapa keputusan yang membedakan aplikasi ini dari desain awal, supaya laporannya
konsisten:

- **Stok tidak disimpan sebagai kolom.** Semua pergerakan masuk ke tabel `mutasi_stok`,
  dan stok dihitung sebagai jumlahnya. Jadi stok di layar kasir tidak mungkin berbeda
  dengan kartu stok di menu Inventory.
- **Pembelian bukan HPP.** Belanja bahan menambah persediaan. Beban pokok baru diakui
  saat bahan benar-benar dipakai produksi.
- **HPP pakai rata-rata bergerak.** Harga bahan dirata-rata tiap ada pembelian baru;
  HPP produk = total nilai bahan satu batch dibagi jumlah porsi yang jadi.
- **Penjualan Grab jadi piutang, bukan kas.** Bruto dikurangi komisi platform (default 20%,
  bisa diubah di menu Master). Nilai bersihnya menumpuk sebagai *Piutang GrabFood* dan baru
  masuk kas saat dicairkan lewat menu Kas — sama seperti saldo GrabMerchant sesungguhnya.
  Piutang ini tampil sebagai aset lancar di neraca.
- **Buku kas adalah turunan transaksi,** bukan form input terpisah — supaya tidak bisa
  berbeda dengan laporan penjualan dan pembelian.
- **Prive bukan beban.** Pengambilan pribadi pemilik mengurangi kas dan ekuitas, tapi
  tidak mengurangi laba. Menyamakannya dengan biaya membuat laba usaha terlihat lebih
  kecil dari yang sebenarnya.
- **Waste dan stock opname tidak menyentuh kas.** Produk tidak laku yang dibuang dan
  selisih hasil hitung fisik mengurangi (atau menambah) nilai persediaan, dan langsung
  diakui sebagai kerugian/keuntungan di laba rugi. Uangnya memang sudah keluar saat
  belanja bahan, jadi tidak boleh dicatat sebagai kas keluar lagi.
- **Modal dan prive diturunkan dari mutasi kas,** tidak disimpan sebagai angka terpisah.

Neraca menampilkan status **SEIMBANG / TIDAK SEIMBANG**. Kalau sampai tidak seimbang,
berarti ada logika yang bocor — itu sinyal bug, bukan hal yang wajar.
