#!/usr/bin/env bash
# Jalankan wizard pendaftaran dari nol, TANPA menyentuh data asli.
#
# Memakai database terpisah (data/demo-baru.sqlite) di port lain, jadi aplikasi
# utama di data/erp.sqlite tetap utuh dan boleh jalan bersamaan di port 3000.
#
#   ./demo-pendaftaran.sh        tanya dulu bila database demo lama masih ada
#   ./demo-pendaftaran.sh -y     langsung hapus tanpa bertanya
set -euo pipefail
cd "$(dirname "$0")"

DB="data/demo-baru.sqlite"
PORT_DEMO="${PORT_DEMO:-3005}"
PAKSA=0
[ "${1:-}" = "-y" ] && PAKSA=1

if [ ! -d node_modules ]; then
  echo "Dependensi belum terpasang. Jalankan dulu:  npm install"
  exit 1
fi

# Database demo harus benar-benar kosong, kalau tidak wizard tidak muncul —
# penanda setup_selesai dari sesi sebelumnya masih tersimpan di sana.
if [ -e "$DB" ]; then
  if [ "$PAKSA" -eq 0 ]; then
    if [ ! -t 0 ]; then
      echo "Database demo lama masih ada: $DB"
      echo "Jalankan dari terminal, atau pakai:  ./demo-pendaftaran.sh -y"
      exit 1
    fi
    echo "Database demo sebelumnya ditemukan: $DB"
    read -r -p "Hapus dan mulai pendaftaran baru? [y/N] " jawab || jawab=""
    case "$jawab" in
      [yY]*) ;;
      *) echo "Dibatalkan. Data asli Anda tidak disentuh."; exit 0 ;;
    esac
  fi
  rm -f "$DB" "$DB"-wal "$DB"-shm
  echo "· database demo lama dihapus"
fi

echo
echo "============================================================"
echo "  MODE DEMO PENDAFTARAN"
echo "  Database : $DB  (terpisah, sekali pakai)"
echo "  Alamat   : http://localhost:$PORT_DEMO"
echo
echo "  Data asli di data/erp.sqlite TIDAK disentuh."
echo "  Hentikan dengan Ctrl+C."
echo "============================================================"
echo

DB_PATH="$DB" PORT="$PORT_DEMO" exec npm start
