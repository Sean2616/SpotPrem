const express = require('express');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = express();
const PORT = process.env.PORT || 3000;

// Lokasi Secret File di Render (/etc/secrets/data-akun.js) atau lokal (./data-akun.js)
function getSecretFilePath() {
    const renderSecretPath = '/etc/secrets/data-akun.js';
    const localPath = path.join(__dirname, 'data-akun.js');
    if (fs.existsSync(renderSecretPath)) {
        return renderSecretPath;
    }
    return localPath;
}

// Endpoint untuk mengirimkan data akun yang sudah diamankan ke frontend
app.get('/data-akun.js', (req, res) => {
    try {
        const filePath = getSecretFilePath();
        if (!fs.existsSync(filePath)) {
            return res.type('application/javascript').send('const accounts = [];');
        }

        const fileContent = fs.readFileSync(filePath, 'utf8');
        
        // Mengekstrak variabel accounts dari file data-akun.js
        const sandbox = {};
        vm.createContext(sandbox);
        vm.runInContext(fileContent + '\n;globalThis.extractedAccounts = accounts;', sandbox);

        const rawAccounts = sandbox.extractedAccounts || [];

        // Sensor email & password dari sisi server jika status akun sedang tidak aktif (available: false)
        const safeAccounts = rawAccounts.map(acc => ({
            id: acc.id,
            plan: acc.plan,
            region: acc.region,
            email: acc.available ? acc.email : '••••••••••••••••••••',
            password: acc.available ? acc.password : 'TIDAK TERSEDIA',
            status: acc.status,
            available: acc.available,
            updatedAt: acc.updatedAt
        }));

        res.set('Cache-Control', 'no-store');
        res.type('application/javascript').send(`const accounts = ${JSON.stringify(safeAccounts)};`);
    } catch (error) {
        console.error('Gagal membaca Secret File data-akun.js:', error.message);
        res.type('application/javascript').send('const accounts = [];');
    }
});

// Menampilkan halaman utama index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});