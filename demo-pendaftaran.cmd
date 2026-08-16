@echo off
setlocal
rem Jalankan wizard pendaftaran dari nol, TANPA menyentuh data asli.
rem
rem Memakai database terpisah (data\demo-baru.sqlite) di port lain, jadi aplikasi
rem utama di data\erp.sqlite tetap utuh dan boleh jalan bersamaan di port 3000.
rem
rem   demo-pendaftaran.cmd        tanya dulu bila database demo lama masih ada
rem   demo-pendaftaran.cmd -y     langsung hapus tanpa bertanya

cd /d "%~dp0"

set "DB=data\demo-baru.sqlite"
if "%PORT_DEMO%"=="" set "PORT_DEMO=3005"

if not exist node_modules (
  echo Dependensi belum terpasang. Jalankan dulu:  npm install
  pause
  exit /b 1
)

rem Database demo harus benar-benar kosong, kalau tidak wizard tidak muncul --
rem penanda setup_selesai dari sesi sebelumnya masih tersimpan di sana.
if not exist "%DB%" goto :mulai
if /i "%~1"=="-y" goto :hapus

echo Database demo sebelumnya ditemukan: %DB%
set "JAWAB="
set /p "JAWAB=Hapus dan mulai pendaftaran baru? [y/N] "
if /i "%JAWAB%"=="y" goto :hapus
echo Dibatalkan. Data asli Anda tidak disentuh.
pause
exit /b 0

:hapus
del /q "%DB%" 2>nul
del /q "%DB%-wal" 2>nul
del /q "%DB%-shm" 2>nul
echo - database demo lama dihapus

:mulai
echo.
echo ============================================================
echo   MODE DEMO PENDAFTARAN
echo   Database : %DB%  (terpisah, sekali pakai)
echo   Alamat   : http://localhost:%PORT_DEMO%
echo.
echo   Data asli di data\erp.sqlite TIDAK disentuh.
echo   Hentikan dengan Ctrl+C.
echo ============================================================
echo.

set "DB_PATH=%DB%"
set "PORT=%PORT_DEMO%"
call npm start

pause
