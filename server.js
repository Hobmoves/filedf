const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory session storage (use Redis/DB in production)
const sessions = new Map();

// Multer config for file uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB default max
});

// ===================
// CONFIGURATION
// ===================
const CONFIG = {
    rawChunkSize: 6000,          // Bytes per chunk BEFORE compression (safe margin)
    sessionTTL: 30 * 60 * 1000,  // 30 minutes
    maxFileSize: 10 * 1024 * 1024, // 10MB
    smartCutChars: [',', ' ', '\n', '\r', '}', ']', ':', ';', '\t'], // Safe break points
    // Whitelist of allowed characters for cleanOutput mode
    allowedChars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,.!?:;-_\'"()[]{}/<>@#$%^&*+=\n'
};

// ===================
// HELPER FUNCTIONS  
// ===================

function cleanBuffer(buffer) {
    // Convert buffer to string, filter only allowed characters
    const str = buffer.toString('utf8');
    let cleaned = '';
    
    for (const char of str) {
        if (CONFIG.allowedChars.includes(char)) {
            cleaned += char;
        }
    }
    
    return Buffer.from(cleaned, 'utf8');
}

function chunkBuffer(buffer, size, smartCut = true) {
    // Split buffer into chunks of specified byte size
    const chunks = [];
    let offset = 0;
    
    while (offset < buffer.length) {
        let end = Math.min(offset + size, buffer.length);
        
        // Smart cut: find a safe break point near the end
        if (smartCut && end < buffer.length) {
            // Look backwards up to 500 bytes for a safe break point
            const searchStart = Math.max(end - 500, offset + 1);
            let bestBreak = -1;
            
            for (let i = end - 1; i >= searchStart; i--) {
                const char = String.fromCharCode(buffer[i]);
                if (CONFIG.smartCutChars.includes(char)) {
                    bestBreak = i + 1; // Cut after the delimiter
                    break;
                }
            }
            
            if (bestBreak > offset) {
                end = bestBreak;
            }
        }
        
        chunks.push(buffer.slice(offset, end));
        offset = end;
    }
    
    return chunks;
}

function compressAndEncodeChunks(buffer, smartCut = true, cleanOutput = false) {
    // 0. Clean the buffer if requested
    let processedBuffer = buffer;
    if (cleanOutput) {
        processedBuffer = cleanBuffer(buffer);
        console.log(`  Cleaned: ${buffer.length} bytes → ${processedBuffer.length} bytes`);
    }
    
    // 1. Split raw file into chunks FIRST (with smart cut if enabled)
    const rawChunks = chunkBuffer(processedBuffer, CONFIG.rawChunkSize, smartCut);
    
    // 2. Gzip + Base64 each chunk independently
    const encodedChunks = rawChunks.map((chunk, i) => {
        const compressed = zlib.gzipSync(chunk);
        const encoded = compressed.toString('base64');
        console.log(`  Chunk ${i}: ${chunk.length} bytes → gzip ${compressed.length} → base64 ${encoded.length} chars`);
        return encoded;
    });
    
    return encodedChunks;
}

function cleanExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.createdAt > CONFIG.sessionTTL) {
            sessions.delete(id);
        }
    }
}

// Cleanup every 5 minutes
setInterval(cleanExpiredSessions, 5 * 60 * 1000);

// ===================
// API ROUTES
// ===================

/**
 * POST /api/session
 * DF creates an upload session
 * Body: { title?, allowedTypes?, maxSize?, callbackUrl? }
 * Returns: { sessionId, uploadUrl }
 */
app.post('/api/session', (req, res) => {
    const sessionId = uuidv4().substring(0, 12); // Shorter ID
    
    // Parse allowedTypes - accept comma-separated string
    let allowedTypes = [];
    if (req.body.allowedTypes) {
        if (typeof req.body.allowedTypes === 'string') {
            // Comma-separated string: ".json,.txt"
            allowedTypes = req.body.allowedTypes.split(',').map(t => t.trim()).filter(t => t);
        } else if (Array.isArray(req.body.allowedTypes)) {
            // Also accept array for backwards compatibility
            allowedTypes = req.body.allowedTypes;
        }
    }

    // Smart cut - enabled by default, can be disabled
    const smartCut = req.body.smartCut !== false;
    
    // Clean output - disabled by default, strips non-whitelisted characters
    const cleanOutput = req.body.cleanOutput === true;

    const session = {
        id: sessionId,
        createdAt: Date.now(),
        config: {
            title: req.body.title || 'File Upload',
            allowedTypes: allowedTypes,
            maxSize: req.body.maxSize || CONFIG.maxFileSize,
            smartCut: smartCut,
            cleanOutput: cleanOutput
        },
        status: 'waiting', // waiting | uploaded | claimed | expired
        file: null,
        chunks: [],
        chunksDelivered: 0
    };
    
    sessions.set(sessionId, session);
    
    res.json({
        success: true,
        sessionId,
        uploadUrl: `/upload/${sessionId}`,
        pollUrl: `/api/session/${sessionId}/status`
    });
});

/**
 * GET /api/session/:id
 * Get session config (for frontend to render)
 */
app.get('/api/session/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }
    
    res.json({
        id: session.id,
        config: session.config,
        status: session.status
    });
});

/**
 * GET /api/session/:id/status  
 * DF polls this to check if file is ready
 */
app.get('/api/session/:id/status', (req, res) => {
    const session = sessions.get(req.params.id);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }
    
    if (session.status === 'waiting') {
        return res.json({
            status: 'waiting',
            ready: false
        });
    }
    
    res.json({
        status: session.status,
        ready: true,
        filename: session.file.originalName,
        filesize: session.file.originalSize,
        encoding: 'gzip+base64',
        totalChunks: session.chunks.length,
        chunksDelivered: session.chunksDelivered
    });
});

/**
 * GET /api/session/:id/chunk/:index
 * DF fetches a specific chunk
 */
app.get('/api/session/:id/chunk/:index', (req, res) => {
    const session = sessions.get(req.params.id);
    const index = parseInt(req.params.index);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    if (session.status === 'waiting') {
        return res.status(400).json({ error: 'No file uploaded yet' });
    }
    
    if (index < 0 || index >= session.chunks.length) {
        return res.status(400).json({ error: 'Invalid chunk index' });
    }
    
    // Track delivery
    if (index >= session.chunksDelivered) {
        session.chunksDelivered = index + 1;
    }
    
    // Mark as claimed if all chunks delivered
    if (session.chunksDelivered >= session.chunks.length) {
        session.status = 'claimed';
    }
    
    res.json({
        index,
        totalChunks: session.chunks.length,
        isLast: index === session.chunks.length - 1,
        data: session.chunks[index]
    });
});

/**
 * GET /api/session/:id/all
 * Alternative: Get all chunks at once (if small enough)
 * Returns dictionary format for DF
 */
app.get('/api/session/:id/all', (req, res) => {
    const session = sessions.get(req.params.id);
    
    if (!session || session.status === 'waiting') {
        return res.status(404).json({ error: 'No file ready' });
    }
    
    // Build dictionary with chunk keys
    const result = {
        filename: session.file.originalName,
        encoding: 'gzip+base64',
        totalChunks: session.chunks.length
    };
    
    // Add chunks as c0, c1, c2, etc.
    session.chunks.forEach((chunk, i) => {
        result[`c${i}`] = chunk;
    });
    
    session.status = 'claimed';
    session.chunksDelivered = session.chunks.length;
    
    res.json(result);
});

/**
 * POST /api/upload/:id
 * Player uploads file
 */
app.post('/api/upload/:id', upload.single('file'), (req, res) => {
    const session = sessions.get(req.params.id);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }
    
    if (session.status !== 'waiting') {
        return res.status(400).json({ error: 'File already uploaded to this session' });
    }
    
    if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
    }
    
    const file = req.file;
    
    // Validate file type if restrictions set
    if (session.config.allowedTypes.length > 0) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!session.config.allowedTypes.includes(ext)) {
            return res.status(400).json({ 
                error: `File type ${ext} not allowed. Allowed: ${session.config.allowedTypes.join(', ')}` 
            });
        }
    }
    
    // Validate size
    if (file.size > session.config.maxSize) {
        return res.status(400).json({ 
            error: `File too large. Max size: ${(session.config.maxSize / 1024 / 1024).toFixed(1)}MB` 
        });
    }
    
    // Chunk first, then compress each independently
    console.log(`[Upload] Session ${session.id}: Processing ${file.originalname} (${file.size} bytes)`);
    const chunks = compressAndEncodeChunks(file.buffer, session.config.smartCut, session.config.cleanOutput);
    const totalEncodedSize = chunks.reduce((sum, c) => sum + c.length, 0);
    
    session.file = {
        originalName: file.originalname,
        originalSize: file.size,
        compressedSize: totalEncodedSize,
        mimeType: file.mimetype
    };
    session.chunks = chunks;
    session.status = 'uploaded';
    
    console.log(`[Upload] Complete: ${chunks.length} chunks, ${totalEncodedSize} total encoded chars`);
    
    res.json({
        success: true,
        filename: file.originalname,
        originalSize: file.size,
        compressedSize: totalEncodedSize,
        chunks: chunks.length,
        compressionRatio: ((1 - totalEncodedSize / file.size) * 100).toFixed(1) + '%'
    });
});

/**
 * GET /
 * Serve the home page
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/home.html'));
});

/**
 * GET /upload/:id
 * Serve the upload page for players
 */
app.get('/upload/:id', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Serve static frontend files
app.use('/static', express.static(path.join(__dirname, '../frontend')));

// ===================
// START SERVER
// ===================
app.listen(PORT, () => {
    console.log(`FileDF server running on http://localhost:${PORT}`);
    console.log(`\nTest flow:`);
    console.log(`1. POST /api/session to create upload session`);
    console.log(`2. Open /upload/{sessionId} in browser`);
    console.log(`3. GET /api/session/{sessionId}/status to poll`);
    console.log(`4. GET /api/session/{sessionId}/chunk/{n} to fetch data`);
});
