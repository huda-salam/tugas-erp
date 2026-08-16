// Server-Sent Events sederhana: satu arah, server → browser.
// Dipakai supaya tab kasir langsung tahu ada pesanan masuk dari WhatsApp/Grab
// tanpa perlu di-refresh manual.
const klien = new Set();

function pasang(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  klien.add(res);
  req.on('close', () => klien.delete(res));
}

function siarkan(tipe, data) {
  const paket = `event: ${tipe}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of klien) {
    try { res.write(paket); } catch { klien.delete(res); }
  }
}

// denyut supaya koneksi tidak diputus perantara saat sepi
const denyut = setInterval(() => {
  for (const res of klien) {
    try { res.write(': denyut\n\n'); } catch { klien.delete(res); }
  }
}, 25000);
denyut.unref();

module.exports = { pasang, siarkan, jumlahKlien: () => klien.size };
