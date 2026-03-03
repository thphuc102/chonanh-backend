const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 Xin chào! API Backend của ChonAnh đang hoạt động trơn tru.',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`✅ Server đang chạy tại cổng ${PORT}`);
    console.log(`🌐 Truy cập: http://localhost:${PORT}`);
});
