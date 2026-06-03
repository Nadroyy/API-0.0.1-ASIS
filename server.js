const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2');
const sharp = require('sharp');
const { createZkTcpService } = require('./src/services/zkTcpService');
const { createZkLogStore } = require('./src/services/zkLogStore');
const {
    createWebhookService,
    WEBHOOK_EVENT_ATTENDANCE_CREATED
} = require('./src/services/webhookService');
const {
    configureApiKeyAuth,
    buildApiKeyPrefix,
    hashApiKey,
    requireAdminApiKey,
    requireClientOrAdminApiKey
} = require('./src/middleware/apiKeyAuth');

const app = express();
const PERSON_LEVEL_DYNAMIC_INPUT = 'input_81f0fcc729e7479a8f16f00e2a959c13';

const config = {
    server: {
        port: parseInteger(process.env.PORT, 3000)
    },
    mysql: {
        host: process.env.MYSQL_HOST || 'localhost',
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'control_asistencia',
        port: parseInteger(process.env.MYSQL_PORT, 3306)
    },
    zk: {
        ip: process.env.ZK_DEVICE_IP || '',
        port: parseInteger(process.env.ZK_DEVICE_PORT, 4370),
        timeoutMs: parseInteger(process.env.ZK_TIMEOUT_MS, 5000),
        pythonBin: process.env.ZK_PYTHON_BIN || 'python'
    }
};

const uploadsDir = path.join(__dirname, 'uploads');
const facesUploadsDir = path.join(uploadsDir, 'faces');
const logsDir = path.join(__dirname, 'logs');
const dataDir = path.join(__dirname, 'data');
const biophotosDir = path.join(dataDir, 'biophotos');
const publicDir = path.join(__dirname, 'public');
const admsTrafficLogPath = path.join(logsDir, 'adms-traffic.log');
const admsCommandResultsLogPath = path.join(logsDir, 'adms-command-results.log');
const admsCommandSentLogPath = path.join(logsDir, 'adms-command-sent.log');
const admsBiodataLogPath = path.join(dataDir, 'adms-biodata.log');
const admsBiophotoLogPath = path.join(dataDir, 'adms-biophoto.log');
const admsAttlogLogPath = path.join(dataDir, 'adms-attlog.log');
const admsPersonsLogPath = path.join(dataDir, 'adms-persons.jsonl');
const admsDevicesLogPath = path.join(dataDir, 'adms-devices.jsonl');
const admsSitesPath = path.join(dataDir, 'adms-sites.json');
const admsCommandQueuePath = path.join(dataDir, 'adms-command-queue.jsonl');
const admsCommandSequencePath = path.join(dataDir, 'adms-command-sequence.json');
const DEFAULT_TARGET_DEVICE_SN = 'UDP3253500049';
const DEFAULT_SITE_ID = 'default';
const LEGACY_DEFAULT_HOSTS = new Set(['', 'localhost', '127.0.0.1', '0.0.0.0', '192.168.2.97']);
const DEFAULT_DEVICE_NAME = 'Dispositivo principal';
const DEFAULT_LOCATION_NAME = 'Sede principal';
const DEFAULT_ADMS_IMAGE_MODE = 'known-working-upload-profile';
const DEFAULT_ADMS_PROFILE_PIN = '3';
const DEFAULT_ADMS_CONTENT_TERMINATOR = 'none';
const logStore = createZkLogStore({
    filePath: path.join(__dirname, 'logs.txt'),
    maxEntries: parseInteger(process.env.ZK_LOG_LIMIT, 200)
});
const zkTcpService = createZkTcpService({
    defaults: config.zk,
    logStore
});

let comandosPendientes = [];
let admsCommandId = 1;
const admsCommandMetadataById = new Map();

ensureDirectory(uploadsDir);
ensureDirectory(facesUploadsDir);
ensureDirectory(logsDir);
ensureDirectory(dataDir);
ensureDirectory(biophotosDir);
ensureDirectory(publicDir);
ensureDefaultAdmsSitesFile();

admsCommandId = initializeAdmsCommandSequence();

const dbPool = mysql.createPool({
    ...config.mysql,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
const db = dbPool.promise();
const webhookService = createWebhookService({
    db,
    logStore
});

configureApiKeyAuth({
    findClientCredentialByPrefix: async keyPrefix => {
        if (!keyPrefix) {
            return null;
        }

        const [rows] = await db.query(`
            SELECT c.id, c.entidad_id, c.key_hash, c.enabled, e.estado AS entidad_estado
            FROM entidad_api_credentials c
            INNER JOIN entidades e ON e.id = c.entidad_id
            WHERE c.key_prefix = ?
            LIMIT 1
        `, [keyPrefix]);
        const credential = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (credential && String(credential.entidad_estado || '').trim().toLowerCase() === 'inactivo') {
            const error = new Error('La entidad está inactiva');
            error.statusCode = 403;
            error.code = 'ENTITY_INACTIVE';
            throw error;
        }
        if (credential) {
            credential.enabled = normalizeAdminEnabled(credential.enabled, false) === true;
        }
        return credential;
    },
    markClientCredentialUsed: async credentialId => {
        const normalizedId = normalizePositiveIntegerId(credentialId);
        if (!normalizedId) {
            return;
        }

        await db.query(
            'UPDATE entidad_api_credentials SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
            [normalizedId]
        );
    }
});

db.getConnection()
    .then(connection => {
        connection.release();
        console.log('MySQL conectado');
    })
    .catch(error => {
        console.error('Error conectando a MySQL:', error.message);
        process.exit(1);
    });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        cb(null, uniqueName + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: parseInteger(process.env.MAX_UPLOAD_MB, 5) * 1024 * 1024
    },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
            return;
        }

        cb(new Error('Solo se permiten imagenes'));
    }
});

app.set('trust proxy', true);
app.use('/iclock', express.text({ type: '*/*', limit: '2mb' }));
app.use('/iclock', admsTrafficLogger);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

function isLegacyUsuariosEnabled() {
    return String(process.env.ENABLE_LEGACY_USUARIOS || '').toLowerCase() === 'true';
}

function requireLegacyUsuariosEnabled(req, res, next) {
    if (isLegacyUsuariosEnabled()) return next();
    return res.status(404).json({
        ok: false,
        message: 'Funcionalidad legacy de usuarios deshabilitada',
        code: 'LEGACY_USUARIOS_DISABLED'
    });
}

app.post('/subir-foto', requireLegacyUsuariosEnabled, upload.single('foto'), asyncHandler(async (req, res) => {
    await ensureLegacyUsuariosTable('/subir-foto');
    const pin = normalizePin(req.body.pin);
    const nombre = normalizeName(req.body.nombre);

    if (!pin || !nombre) {
        return res.status(400).json({ ok: false, error: 'Faltan pin o nombre validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'No se recibio ninguna foto' });
    }

    const foto = req.file.filename;

    await db.query(
        `INSERT INTO usuarios (pin, nombre, foto, estado)
         VALUES (?, ?, ?, 'pendiente')
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), foto = VALUES(foto), estado = 'pendiente'`,
        [pin, nombre, foto]
    );

    logStore.info('adms.photo.upload', {
        pin,
        nombre,
        foto
    });

    res.json({
        ok: true,
        mensaje: 'Usuario creado. Debe registrar su rostro en el dispositivo.',
        pin,
        nombre,
        foto,
        url: `/uploads/${foto}`
    });
}));

app.post('/enviar-template', requireLegacyUsuariosEnabled, asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const template = typeof req.body.template === 'string' ? req.body.template.trim() : '';

    if (!pin || !template) {
        return res.status(400).json({ ok: false, error: 'Faltan pin o template' });
    }

    if (template.length < 100) {
        return res.status(400).json({ ok: false, error: 'Template invalido o demasiado corto' });
    }

    encolarComando(`C:DATA UPDATE USERINFO PIN=${pin} Name=Clonado${pin} Password=`);
    encolarComando(`C:DATA UPDATE BIODATA PIN=${pin} Tmp=${template}`);

    logStore.info('adms.template.queued', {
        pin,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        mensaje: 'Template encolado para envio al dispositivo',
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/actualizar-usuario', requireLegacyUsuariosEnabled, asyncHandler(async (req, res) => {
    await ensureLegacyUsuariosTable('/actualizar-usuario');
    const pin = normalizePin(req.body.pin);
    const nuevoNombre = normalizeName(req.body.nuevoNombre);

    if (!pin || !nuevoNombre) {
        return res.status(400).json({ ok: false, error: 'Faltan pin o nuevoNombre validos' });
    }

    const [result] = await db.query('UPDATE usuarios SET nombre = ? WHERE pin = ?', [nuevoNombre, pin]);

    if (result.affectedRows === 0) {
        return res.status(404).json({ ok: false, error: `Usuario con PIN ${pin} no existe` });
    }

    logStore.info('adms.user.updated', {
        pin,
        nuevoNombre
    });

    res.json({ ok: true, mensaje: `Nombre actualizado a "${nuevoNombre}"` });
}));

app.all('/iclock/getrequest', asyncHandler(async (req, res) => {
    // Registrar dispositivo
    const sn = String(req.query.SN || '').trim();
    if (sn) {
        updateAdmsDevice(sn, req.ip, req.originalUrl, req.method, req.get('User-Agent'));
    }

    if (isMysqlCommandDispatchEnabled()) {
        try {
            const mysqlCommands = await flushPendingMysqlCommands(sn);
            if (mysqlCommands) {
                return sendPlainText(res, mysqlCommands);
            }
        } catch (error) {
            logStore.error('adms.command.mysql-dispatch.error', {
                sn: sn || null,
                error: error.message
            });
        }
    }

    sendPlainText(res, flushPendingCommands(sn));
}));

app.all('/iclock/cdata', asyncHandler(async (req, res) => {
    // Registrar dispositivo
    const sn = String(req.query.SN || '').trim();
    if (sn) {
        updateAdmsDevice(sn, req.ip, req.originalUrl, req.method, req.get('User-Agent'));
    }

    const body = getRawIclockBody(req);

    logStore.info('adms.request.received', {
        endpoint: '/iclock/cdata',
        ip: req.ip,
        query: req.query,
        bodyLength: body.length
    });

    if (!body) {
        return sendPlainText(res, flushPendingCommands(sn));
    }

    await procesarMensajeUser(body);
    await procesarBiodata(body);
    await procesarBiophotos(body);

    const registros = procesarRegistros(body);
    for (const registro of registros) {
        logStore.info('adms.attendance.received', registro);
        fs.appendFileSync(
            path.join(__dirname, 'asistencias.txt'),
            `[${new Date().toISOString()}] PIN: ${registro.pin} - ${registro.fecha} - ${registro.metodoTexto}\n`
        );
    }

    const attendanceEntries = await persistirAttlog(registros, req);
    for (const attendanceEntry of attendanceEntries) {
        void webhookService.emitAttendanceCreatedWebhook(attendanceEntry);
    }

    sendPlainText(res, flushPendingCommands(sn));
}));

app.all('/iclock/devicecmd', asyncHandler(async (req, res) => {
    // Registrar dispositivo
    const sn = String(req.query.SN || '').trim();
    if (sn) {
        // Extraer informaciÃ³n adicional si estÃ¡ disponible
        const body = getRawIclockBody(req);
        const options = {};

        // Buscar UserCount, FaceCount, etc. en el body
        const userCountMatch = body.match(/UserCount=(\d+)/i);
        if (userCountMatch) options.userCount = parseInt(userCountMatch[1], 10);

        const faceCountMatch = body.match(/FaceCount=(\d+)/i);
        if (faceCountMatch) options.faceCount = parseInt(faceCountMatch[1], 10);

        const multiBioDataCountMatch = body.match(/MultiBioDataCount=(\d+)/i);
        if (multiBioDataCountMatch) options.multiBioDataCount = parseInt(multiBioDataCountMatch[1], 10);

        const multiBioPhotoCountMatch = body.match(/MultiBioPhotoCount=(\d+)/i);
        if (multiBioPhotoCountMatch) options.multiBioPhotoCount = parseInt(multiBioPhotoCountMatch[1], 10);

        updateAdmsDevice(sn, req.ip, req.originalUrl, req.method, req.get('User-Agent'), options);
    }

    const results = parseAdmsDevicecmdResults(req);
    const affectedPins = new Set();

    logStore.info('adms.devicecmd.received', {
        ip: req.ip,
        query: req.query,
        sn: String(req.query.SN || '').trim(),
        results: results.length,
        bodyLength: getRawIclockBody(req).length
    });

    for (const result of results) {
        const existingEntry = result.id ? findAdmsCommandQueueEntry(result.id) : null;

        appendAdmsCommandResultLog({
            timestamp: new Date().toISOString(),
            ip: req.ip,
            originalUrl: req.originalUrl,
            sn: result.sn,
            ackDeviceSn: result.sn || null,
            id: result.id,
            targetDeviceSn: existingEntry ? resolveQueueEntryTargetDeviceSn(existingEntry) : null,
            return: result.returnValue,
            cmd: result.cmd,
            rawLine: result.rawLine,
            body: result.rawBody
        });

        if (!result.id) {
            continue;
        }

        const ackDeviceSn = String(result.sn || '').trim();
        const targetDeviceSn = existingEntry ? resolveQueueEntryTargetDeviceSn(existingEntry) : '';
        if (existingEntry && ackDeviceSn && targetDeviceSn && ackDeviceSn !== targetDeviceSn) {
            logStore.warn('adms.devicecmd.target-mismatch', {
                commandId: String(result.id),
                ackDeviceSn,
                targetDeviceSn,
                rawLine: result.rawLine
            });
            continue;
        }

        const acknowledgedAt = new Date().toISOString();
        const status = String(result.returnValue) === '0' ? 'accepted' : 'failed';
        void updateMysqlAdmsCommandAck(result.id, {
            acknowledgedAt,
            status,
            returnCode: result.returnValue,
            ackDeviceSn: ackDeviceSn || null,
            rawLine: String(result.rawLine || result.rawBody || '')
        });

        const updatedEntry = updateAdmsCommandQueueEntry(result.id, {
            acknowledgedAt,
            status,
            returnCode: result.returnValue,
            ackDeviceSn: ackDeviceSn || null,
            rawLine: String(result.rawLine || result.rawBody || '')
        });

        if (updatedEntry && (updatedEntry.commandType === 'DELETE_USERINFO' || updatedEntry.purpose === 'delete-person')) {
            updateDeleteAuditForDeviceCommand(result.id, {
                deviceDeleteStatus: status,
                deviceDeleteReturnCode: result.returnValue,
                deviceDeleteAcknowledgedAt: acknowledgedAt,
                deviceDeleteRawLine: String(result.rawLine || result.rawBody || '')
            });
        }

        if (updatedEntry) {
            await updateMysqlPersonDeviceSyncStatusFromCommand(
                updatedEntry,
                status === 'accepted' ? 'synced' : 'failed'
            );
        }

        if (updatedEntry && updatedEntry.pin) {
            affectedPins.add(String(updatedEntry.pin));
        }
    }

    for (const pin of affectedPins) {
        const syncStatus = computeDeviceSyncStatusForPin(pin);
        updateAdmsPersonSyncStatus(pin, syncStatus);
    }

    sendPlainText(res, 'OK');
}));

function isInternalAdmsToolsEnabled() {
    return String(process.env.ENABLE_INTERNAL_ADMS_TOOLS || '').toLowerCase() === 'true';
}

function requireInternalAdmsToolsEnabled(req, res, next) {
    if (isInternalAdmsToolsEnabled()) return next();
    return res.status(404).json({
        ok: false,
        message: 'Herramientas internas ADMS deshabilitadas',
        code: 'ADMS_INTERNAL_TOOLS_DISABLED'
    });
}

app.use('/adms', requireInternalAdmsToolsEnabled);

app.post('/adms/queue-user', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const admsName = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const admsPassword = normalizeAdmsQueueField(rawPassword, 24, false);

    if (!pin || !admsName) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin numerico y name valido' });
    }

    const targetContext = resolveCommandTargetMetadata(req.body);
    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name: admsName,
        password: admsPassword,
        verify: 0,
        ...targetContext
    });

    logStore.info('adms.queue-user.enqueued', {
        pin,
        name: admsName,
        commandId: userCommand.commandId,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        commandId: userCommand.commandId,
        command: userCommand.command,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/request-user-data', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin valido' });
    }

    const commandId = allocateAdmsCommandId();
    const command = `C:${commandId}:DATA QUERY USERINFO PIN=${pin}`;
    const targetContext = resolveCommandTargetMetadata(req.body);
    enqueueAdmsCommandEntry({
        commandId,
        commandType: 'USERINFO',
        pin,
        command,
        purpose: 'query-userinfo',
        ...targetContext
    });

    logStore.info('adms.request-user-data.enqueued', {
        pin,
        commandId,
        command,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        pin,
        commandId,
        command,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/request-biodata', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin valido' });
    }

    const commandId = allocateAdmsCommandId();
    const command = `C:${commandId}:DATA QUERY BIODATA Pin=${pin}`;
    const targetContext = resolveCommandTargetMetadata(req.body);
    enqueueAdmsCommandEntry({
        commandId,
        commandType: 'BIODATA',
        pin,
        command,
        purpose: 'query-biodata',
        ...targetContext
    });

    logStore.info('adms.request-biodata.enqueued', {
        pin,
        commandId,
        command,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        pin,
        commandId,
        command,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/request-biophoto', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin valido' });
    }

    const commandId = allocateAdmsCommandId();
    const command = `C:${commandId}:DATA QUERY BIOPHOTO PIN=${pin}`;
    const targetContext = resolveCommandTargetMetadata(req.body);
    enqueueAdmsCommandEntry({
        commandId,
        commandType: 'BIOPHOTO',
        pin,
        command,
        purpose: 'query-biophoto',
        ...targetContext
    });

    logStore.info('adms.request-biophoto.enqueued', {
        pin,
        commandId,
        command,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        pin,
        commandId,
        command,
        pendingCommands: comandosPendientes.length
    });
}));

app.get('/adms/biodata', asyncHandler(async (_req, res) => {
    res.json(readJsonLinesFile(admsBiodataLogPath));
}));

app.get('/adms/biophotos', asyncHandler(async (_req, res) => {
    res.json(readJsonLinesFile(admsBiophotoLogPath));
}));

app.get('/adms/attendance', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.query.pin);
    res.json(readAttendanceEntries({
        pin,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit
    }));
}));

app.get('/adms/attendance/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    res.json(readAttendanceEntries({
        pin,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit
    }));
}));

app.get('/adms/attendance-summary', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.query.pin);
    const date = normalizeDateFilter(req.query.date);

    if (!pin || !date) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin y date validos' });
    }

    res.json(buildAttendanceSummary(pin, date));
}));

app.post('/adms/queue-user-verify', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const admsName = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const admsPassword = normalizeAdmsQueueField(rawPassword, 24, false);
    const verify = Number.parseInt(req.body.verify, 10);

    if (!pin || !admsName || !admsPassword || !Number.isInteger(verify) || verify < 0 || verify > 255) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name, password y verify validos' });
    }

    const targetContext = resolveCommandTargetMetadata(req.body);
    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name: admsName,
        password: admsPassword,
        verify,
        ...targetContext
    });

    logStore.info('adms.queue-user-verify.enqueued', {
        pin,
        name: admsName,
        verify,
        commandId: userCommand.commandId,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        commandId: userCommand.commandId,
        command: userCommand.command,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/queue-copy-face', asyncHandler(async (req, res) => {
    const sourcePin = normalizePin(req.body.sourcePin);
    const targetPin = normalizePin(req.body.targetPin);

    if (!sourcePin || !targetPin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar sourcePin y targetPin validos' });
    }

    const targetContext = resolveCommandTargetMetadata(req.body);
    const faceCommands = enqueueAdmsFaceCopyCommands(sourcePin, targetPin, targetContext);

    logStore.info('adms.queue-copy-face.enqueued', {
        sourcePin,
        targetPin,
        biophotoCommandId: faceCommands.commandIds.biophoto,
        biodataCommandId: faceCommands.commandIds.biodata,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        sourcePin,
        targetPin,
        commandIds: faceCommands.commandIds,
        summary: faceCommands.summary,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/enroll-user-with-face', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);
    const sourceFacePin = normalizePin(req.body.sourceFacePin);

    if (!pin || !name || !sourceFacePin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name y sourceFacePin validos' });
    }

    const targetContext = resolveCommandTargetMetadata(req.body);
    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name,
        password,
        verify: 0,
        ...targetContext
    });
    const faceCommands = enqueueAdmsFaceCopyCommands(sourceFacePin, pin, targetContext);

    logStore.info('adms.enroll-user-with-face.enqueued', {
        pin,
        sourceFacePin,
        userCommandId: userCommand.commandId,
        biophotoCommandId: faceCommands.commandIds.biophoto,
        biodataCommandId: faceCommands.commandIds.biodata,
        pendingCommands: comandosPendientes.length
    });

    res.json({
        ok: true,
        pin,
        userCommandId: userCommand.commandId,
        faceCommandIds: faceCommands.commandIds,
        pendingCommands: comandosPendientes.length
    });
}));

app.post('/adms/enroll-user-with-photo-file', upload.single('image'), asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);
    const imageMode = normalizeImageMode(req.body.imageMode || DEFAULT_ADMS_IMAGE_MODE);
    const profilePin = normalizeProfilePin(req.body.profilePin || DEFAULT_ADMS_PROFILE_PIN);
    const contentTerminator = normalizeContentTerminator(req.body.contentTerminator || DEFAULT_ADMS_CONTENT_TERMINATOR);

    if (!pin || !name || !password) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name y password validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Debes enviar image en multipart/form-data' });
    }

    validateExplicitSiteDeviceAccess(req.body.siteId, req.body.targetDeviceSn);
    const targetContext = resolveCommandTargetMetadata(req.body);
    const enrollment = await enqueueAdmsPhotoEnrollment({
        pin,
        name,
        password,
        tempFilePath: req.file.path,
        imageMode,
        profilePin,
        contentTerminator,
        ...targetContext
    });

    logStore.info('adms.enroll-user-with-photo-file.enqueued', {
        pin,
        name,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedAs: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize,
        warning: 'BIOPHOTO enviado; reconocimiento facial puede requerir BIODATA'
    });

    res.json({
        ok: true,
        pin,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedAs: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize,
        warning: 'BIOPHOTO enviado; reconocimiento facial puede requerir BIODATA'
    });
}));

app.post('/adms/enroll-person', upload.single('image'), asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);
    const imageMode = normalizeImageMode(req.body.imageMode || DEFAULT_ADMS_IMAGE_MODE);
    const profilePin = normalizeProfilePin(req.body.profilePin || DEFAULT_ADMS_PROFILE_PIN);
    const contentTerminator = normalizeContentTerminator(req.body.contentTerminator || DEFAULT_ADMS_CONTENT_TERMINATOR);

    if (!pin || !name || !password) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name y password validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Debes enviar image en multipart/form-data' });
    }

    validateExplicitSiteDeviceAccess(req.body.siteId, req.body.targetDeviceSn);
    const targetContext = resolveCommandTargetMetadata(req.body);
    const enrollment = await enqueueAdmsPhotoEnrollment({
        pin,
        name,
        password,
        tempFilePath: req.file.path,
        imageMode,
        profilePin,
        contentTerminator,
        ...targetContext
    });
    await syncEnrolledPersonState({
        pin,
        name,
        photo: enrollment.savedPhoto
    });
    persistAdmsPerson({
        pin,
        name,
        photo: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        siteId: targetContext.siteId,
        targetDeviceSn: targetContext.targetDeviceSn
    });

    logStore.info('adms.enroll-person.enqueued', {
        pin,
        name,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedPhoto: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize
    });

    res.json({
        ok: true,
        pin,
        name,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedPhoto: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize,
        message: 'Persona encolada para enrolamiento ADMS'
    });
}));

app.post('/adms/enroll-person-with-template', upload.single('image'), asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const rawName = typeof req.body.name === 'string' ? req.body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof req.body.password === 'string' ? req.body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);
    const sourceFacePin = normalizePin(req.body.sourceFacePin);
    const imageMode = normalizeImageMode(req.body.imageMode || DEFAULT_ADMS_IMAGE_MODE);
    const profilePin = normalizeProfilePin(req.body.profilePin || DEFAULT_ADMS_PROFILE_PIN);
    const contentTerminator = normalizeContentTerminator(req.body.contentTerminator || DEFAULT_ADMS_CONTENT_TERMINATOR);

    if (!pin || !name || !password || !sourceFacePin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin, name, password y sourceFacePin validos' });
    }

    if (!req.file) {
        return res.status(400).json({ ok: false, error: 'Debes enviar image en multipart/form-data' });
    }

    validateExplicitSiteDeviceAccess(req.body.siteId, req.body.targetDeviceSn);
    const targetContext = resolveCommandTargetMetadata(req.body);
    const enrollment = await enqueueAdmsPhotoEnrollment({
        pin,
        name,
        password,
        tempFilePath: req.file.path,
        imageMode,
        profilePin,
        contentTerminator,
        ...targetContext
    });
    const biodataCommandId = enqueueAdmsBiodataFromSource(sourceFacePin, pin, targetContext);
    await syncEnrolledPersonState({
        pin,
        name,
        photo: enrollment.savedPhoto
    });

    persistAdmsPerson({
        pin,
        name,
        photo: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        biodataCommandId,
        siteId: targetContext.siteId,
        targetDeviceSn: targetContext.targetDeviceSn
    });

    logStore.info('adms.enroll-person-with-template.enqueued', {
        pin,
        name,
        sourceFacePin,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        biodataCommandId,
        savedPhoto: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize
    });

    res.json({
        ok: true,
        pin,
        name,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        biodataCommandId,
        savedPhoto: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize,
        sourceFacePin,
        message: 'Persona encolada con USERINFO + BIOPHOTO + BIODATA'
    });
}));

app.get('/adms/persons', asyncHandler(async (_req, res) => {
    res.json(readLatestAdmsPersons());
}));

app.get('/adms/persons/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    const person = readLatestAdmsPersonByPin(pin);
    if (!person) {
        return res.status(404).json({ ok: false, error: 'Persona no encontrada' });
    }

    res.json({
        ...person,
        attendance: readAttendanceEntries({ pin, limit: 10 })
    });
}));

app.post('/adms/persons/rebuild', asyncHandler(async (_req, res) => {
    const rebuilt = rebuildAdmsPersonsFromFiles();
    res.json({
        ok: true,
        rebuilt: rebuilt.length,
        persons: rebuilt
    });
}));

app.get('/adms/command-status', asyncHandler(async (req, res) => {
    const ids = String(req.query.ids || '')
        .split(',')
        .map(value => String(value || '').trim())
        .filter(Boolean);

    if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'Debes enviar ids' });
    }

    res.json(ids.map(id => readAdmsCommandStatus(id)));
}));

app.get('/adms/command-status/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) {
        return res.status(400).json({ ok: false, error: 'ID invalido' });
    }

    res.json(readAdmsCommandStatus(id));
}));

app.get('/usuarios', requireLegacyUsuariosEnabled, asyncHandler(async (_req, res) => {
    await ensureLegacyUsuariosTable('/usuarios');
    const [rows] = await db.query('SELECT * FROM usuarios');
    res.json(rows);
}));

app.get('/pendientes', requireLegacyUsuariosEnabled, asyncHandler(async (_req, res) => {
    await ensureLegacyUsuariosTable('/pendientes');
    const [rows] = await db.query("SELECT * FROM usuarios WHERE estado = 'pendiente'");
    res.json(rows);
}));

app.get('/activos', requireLegacyUsuariosEnabled, asyncHandler(async (_req, res) => {
    await ensureLegacyUsuariosTable('/activos');
    const [rows] = await db.query("SELECT * FROM usuarios WHERE estado = 'activo'");
    res.json(rows);
}));

app.get('/usuario/:pin', requireLegacyUsuariosEnabled, asyncHandler(async (req, res) => {
    await ensureLegacyUsuariosTable('/usuario/:pin');
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    const [rows] = await db.query('SELECT * FROM usuarios WHERE pin = ?', [pin]);
    if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }

    res.json(rows[0]);
}));

app.get('/foto/:pin', requireLegacyUsuariosEnabled, asyncHandler(async (req, res) => {
    await ensureLegacyUsuariosTable('/foto/:pin');
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN invalido' });
    }

    const [rows] = await db.query('SELECT foto FROM usuarios WHERE pin = ?', [pin]);
    if (rows.length === 0 || !rows[0].foto) {
        return res.status(404).json({ ok: false, error: 'No encontrado' });
    }

    res.sendFile(path.join(uploadsDir, rows[0].foto));
}));

app.get('/health', (_req, res) => {
    res.json({
        estado: 'Servidor activo',
        bd: config.mysql.database,
        puerto: config.server.port,
        tcpZk: config.zk.ip
            ? {
                enabled: true,
                ip: config.zk.ip,
                port: config.zk.port,
                timeoutMs: config.zk.timeoutMs
            }
            : {
                enabled: false
            }
    });
});

app.get('/panel', requireInternalAdmsToolsEnabled, (_req, res) => {
    res.sendFile(path.join(publicDir, 'adms-panel.html'));
});

function isZkTcpEnabled() {
    return String(process.env.ENABLE_ZK_TCP || '').toLowerCase() === 'true';
}

function requireZkTcpEnabled(req, res, next) {
    if (isZkTcpEnabled()) return next();
    return res.status(404).json({
        ok: false,
        message: 'Funcionalidad TCP ZKTeco deshabilitada',
        code: 'ZK_TCP_DISABLED'
    });
}

app.use('/zk', requireZkTcpEnabled);

app.post('/zk/connect', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/connect', () => zkTcpService.connect(resolveZkOptions(req)));
}));

app.get('/zk/test-connection', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/test-connection', () => zkTcpService.testConnection(resolveZkOptions(req)), 503);
}));

app.get('/zk/ping', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/ping', () => zkTcpService.ping(resolveZkOptions(req)), 503);
}));

app.get('/zk/device-info', asyncHandler(async (req, res) => {
    await handleZkEndpoint(req, res, '/zk/device-info', () => zkTcpService.getDeviceInfo(resolveZkOptions(req)), 503);
}));

app.get('/zk/users', asyncHandler(async (req, res) => {
    const result = await zkTcpService.getUsers(resolveZkOptions(req));
    res.json(result);
}));

app.post('/zk/create-user', asyncHandler(async (req, res) => {
    const rawPassword = req.body.password;
    const payload = {
        ...resolveZkOptions(req),
        uid: normalizeUid(req.body.uid || req.body.pin),
        userId: normalizeUserId(req.body.userId || req.body.uid || req.body.pin),
        name: normalizeName(req.body.name || req.body.nombre),
        password: normalizePassword(rawPassword),
        role: parseInteger(req.body.role, 0),
        cardNo: req.body.cardNo ? String(req.body.cardNo).trim() : ''
    };

    if (!payload.uid || !payload.userId || !payload.name) {
        return res.status(400).json({
            ok: false,
            error: 'Debes enviar uid, userId o pin, y name'
        });
    }

    if (rawPassword !== undefined && payload.password === null) {
        return res.status(400).json({ ok: false, error: 'Password invalido. Usa 1-16 caracteres ASCII sin espacios.' });
    }

    const result = await zkTcpService.createUser(payload);
    res.status(201).json(result);
}));

app.post('/zk/update-user', asyncHandler(async (req, res) => {
    const payload = {
        ...resolveZkOptions(req),
        uid: normalizeUid(req.body.uid || req.body.pin),
        userId: normalizeUserId(req.body.userId || req.body.uid || req.body.pin),
        name: normalizeName(req.body.name || req.body.nombre),
        password: normalizePassword(req.body.password),
        role: parseInteger(req.body.role, 0),
        cardNo: req.body.cardNo ? String(req.body.cardNo).trim() : ''
    };

    if (!payload.uid || !payload.userId) {
        return res.status(400).json({
            ok: false,
            error: 'Debes enviar uid y/o userId'
        });
    }

    const result = await zkTcpService.updateUser(payload);
    res.json(result);
}));

app.delete('/zk/user/:uid', asyncHandler(async (req, res) => {
    const payload = {
        ...resolveZkOptions(req),
        uid: normalizeUid(req.params.uid),
        userId: normalizeUserId(req.query.userId)
    };

    if (!payload.uid) {
        return res.status(400).json({ ok: false, error: 'UID invalido' });
    }

    const result = await zkTcpService.deleteUser(payload);
    res.json(result);
}));

app.get('/zk/logs', (req, res) => {
    const limit = Math.min(parseInteger(req.query.limit, 50), 200);
    res.json({
        ok: true,
        total: limit,
        logs: logStore.getEntries(limit)
    });
});

app.use('/faces', requireInternalAdmsToolsEnabled, express.static(facesUploadsDir));
app.use('/uploads', requireInternalAdmsToolsEnabled, express.static(uploadsDir));

function ensureDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, { recursive: true });
    }
}

function admsTrafficLogger(req, _res, next) {
    appendAdmsTrafficLog({
        timestamp: new Date().toISOString(),
        method: req.method,
        originalUrl: req.originalUrl,
        query: req.query,
        headers: {
            'user-agent': req.headers['user-agent'] || '',
            'content-type': req.headers['content-type'] || '',
            'content-length': req.headers['content-length'] || ''
        },
        ip: req.ip,
        body: getRawIclockBody(req)
    });

    next();
}

function appendAdmsTrafficLog(entry) {
    fs.appendFileSync(admsTrafficLogPath, `${JSON.stringify(entry)}\n`);
}

function appendAdmsCommandResultLog(entry) {
    fs.appendFileSync(admsCommandResultsLogPath, `${JSON.stringify(entry)}\n`);
}

function appendJsonLine(filePath, entry) {
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

function buildDefaultAdmsSites() {
    return {
        sites: [
            {
                siteId: DEFAULT_SITE_ID,
                name: DEFAULT_LOCATION_NAME,
                hostname: null,
                allowedDeviceSns: [DEFAULT_TARGET_DEVICE_SN],
                enabled: true
            }
        ]
    };
}

function ensureDefaultAdmsSitesFile() {
    if (fs.existsSync(admsSitesPath)) {
        return;
    }

    fs.writeFileSync(admsSitesPath, JSON.stringify(buildDefaultAdmsSites(), null, 2));
}

function readJsonLinesFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    return fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (_error) {
                return null;
            }
        })
        .filter(Boolean);
}

function writeJsonLinesFile(filePath, entries) {
    const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const fileContent = normalizedEntries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(filePath, fileContent ? `${fileContent}\n` : '');
}

function readAdmsSites() {
    ensureDefaultAdmsSitesFile();

    try {
        const parsed = JSON.parse(fs.readFileSync(admsSitesPath, 'utf8'));
        const sites = Array.isArray(parsed?.sites) ? parsed.sites : [];
        if (sites.length === 0) {
            return buildDefaultAdmsSites().sites;
        }

        return sites.map(site => ({
            siteId: String(site.siteId || DEFAULT_SITE_ID),
            name: String(site.name || DEFAULT_LOCATION_NAME),
            hostname: site.hostname == null ? null : String(site.hostname),
            allowedDeviceSns: Array.isArray(site.allowedDeviceSns)
                ? site.allowedDeviceSns.map(value => String(value || '').trim()).filter(Boolean)
                : [],
            enabled: site.enabled !== false
        }));
    } catch (_error) {
        return buildDefaultAdmsSites().sites;
    }
}

function writeAdmsSites(sites) {
    const normalizedSites = Array.isArray(sites) && sites.length > 0
        ? sites.map(site => ({
            siteId: String(site.siteId || DEFAULT_SITE_ID),
            name: String(site.name || DEFAULT_LOCATION_NAME),
            hostname: site.hostname == null ? null : String(site.hostname),
            allowedDeviceSns: Array.isArray(site.allowedDeviceSns)
                ? Array.from(new Set(site.allowedDeviceSns.map(value => String(value || '').trim()).filter(Boolean)))
                : [],
            enabled: site.enabled !== false
        }))
        : buildDefaultAdmsSites().sites;

    fs.writeFileSync(admsSitesPath, JSON.stringify({ sites: normalizedSites }, null, 2));
    return normalizedSites;
}

function getSiteForHost(hostname) {
    const normalizedHost = normalizeRequestHostname(hostname);
    if (!normalizedHost) {
        return null;
    }

    return readAdmsSites().find(site => String(site.hostname || '').trim().toLowerCase() === normalizedHost) || null;
}

function normalizeRequestHostname(hostname) {
    return String(hostname || '').trim().toLowerCase().split(':')[0];
}

function resolveSiteFromRequest(req) {
    const sites = readAdmsSites();
    const requestedSiteId = String(req.query?.siteId || '').trim();
    const hostname = normalizeRequestHostname(
        req.headers['x-forwarded-host']
        || req.headers.host
        || req.hostname
    );
    const defaultSite = getDefaultSite();

    if (requestedSiteId) {
        const requestedSite = findAdmsSiteById(requestedSiteId, sites);
        if (requestedSite && requestedSite.enabled !== false) {
            return {
                siteId: requestedSite.siteId,
                siteName: requestedSite.name,
                hostname: hostname || 'localhost',
                matchedBy: 'query-siteId',
                unknownHost: false,
                allowedDeviceSns: Array.isArray(requestedSite.allowedDeviceSns) ? requestedSite.allowedDeviceSns : []
            };
        }
    }

    if (LEGACY_DEFAULT_HOSTS.has(hostname)) {
        return {
            siteId: defaultSite.siteId,
            siteName: defaultSite.name,
            hostname: hostname || 'localhost',
            matchedBy: 'legacy-default',
            unknownHost: false,
            allowedDeviceSns: Array.isArray(defaultSite.allowedDeviceSns) ? defaultSite.allowedDeviceSns : []
        };
    }

    const matchedSite = sites.find(site => normalizeRequestHostname(site.hostname) === hostname) || null;
    if (matchedSite) {
        return {
            siteId: matchedSite.siteId,
            siteName: matchedSite.name,
            hostname,
            matchedBy: 'hostname',
            unknownHost: false,
            allowedDeviceSns: Array.isArray(matchedSite.allowedDeviceSns) ? matchedSite.allowedDeviceSns : []
        };
    }

    return {
        siteId: defaultSite.siteId,
        siteName: defaultSite.name,
        hostname: hostname || 'localhost',
        matchedBy: 'fallback-default',
        unknownHost: true,
        allowedDeviceSns: Array.isArray(defaultSite.allowedDeviceSns) ? defaultSite.allowedDeviceSns : []
    };
}

function getDefaultSite() {
    return readAdmsSites().find(site => String(site.siteId) === DEFAULT_SITE_ID) || buildDefaultAdmsSites().sites[0];
}

function findAdmsSiteById(siteId, sites = readAdmsSites()) {
    const normalizedSiteId = String(siteId || '').trim();
    return sites.find(site => String(site.siteId || '').trim() === normalizedSiteId) || null;
}

function buildDeviceRecord(sn, rawDevice = {}, sites = readAdmsSites()) {
    const normalizedSn = String(sn || rawDevice.sn || DEFAULT_TARGET_DEVICE_SN).trim() || DEFAULT_TARGET_DEVICE_SN;
    const matchedSite = sites.find(site => Array.isArray(site.allowedDeviceSns) && site.allowedDeviceSns.includes(normalizedSn)) || null;
    const defaultSite = matchedSite || getDefaultSite();
    const isAllowed = Boolean(matchedSite);
    const resolvedSiteId = isAllowed
        ? String(rawDevice.siteId || matchedSite.siteId || DEFAULT_SITE_ID)
        : 'unassigned';
    const resolvedLocationName = isAllowed
        ? String(rawDevice.locationName || matchedSite.name || DEFAULT_LOCATION_NAME)
        : 'No asignado';
    const resolvedEnabled = isAllowed && rawDevice.enabled !== false;

    return {
        sn: normalizedSn,
        name: String(rawDevice.name || rawDevice.deviceName || (normalizedSn === DEFAULT_TARGET_DEVICE_SN ? DEFAULT_DEVICE_NAME : `Dispositivo ${normalizedSn}`)),
        deviceName: String(rawDevice.deviceName || rawDevice.name || (normalizedSn === DEFAULT_TARGET_DEVICE_SN ? DEFAULT_DEVICE_NAME : `Dispositivo ${normalizedSn}`)),
        siteId: resolvedSiteId,
        ip: String(rawDevice.ip || ''),
        enabled: resolvedEnabled,
        discoveredOnly: !isAllowed,
        hostname: rawDevice.hostname == null ? (isAllowed ? (matchedSite.hostname ?? null) : null) : String(rawDevice.hostname),
        locationName: resolvedLocationName,
        ultima_conexion: rawDevice.ultima_conexion || null,
        lastSeenAt: rawDevice.lastSeenAt || rawDevice.ultima_conexion || null,
        lastOriginalUrl: rawDevice.lastOriginalUrl || null,
        lastMethod: rawDevice.lastMethod || null,
        lastUserAgent: rawDevice.lastUserAgent || null,
        userCount: rawDevice.userCount || null,
        faceCount: rawDevice.faceCount || null,
        multiBioDataCount: rawDevice.multiBioDataCount || null,
        multiBioPhotoCount: rawDevice.multiBioPhotoCount || null
    };
}

function getDeviceConfigBySn(sn) {
    const normalizedSn = String(sn || '').trim() || DEFAULT_TARGET_DEVICE_SN;
    const rawDevices = readJsonLinesFile(admsDevicesLogPath);
    const rawDevice = rawDevices.find(entry => String(entry.sn || '').trim() === normalizedSn) || {};
    return buildDeviceRecord(normalizedSn, rawDevice);
}

function resolveDefaultTargetDeviceSn() {
    const devices = readAdmsDevices().filter(device => device.enabled !== false);
    return devices[0]?.sn || DEFAULT_TARGET_DEVICE_SN;
}

function validateExplicitSiteDeviceAccess(siteId, targetDeviceSn) {
    const normalizedSiteId = String(siteId || '').trim();
    const normalizedSn = String(targetDeviceSn || '').trim();

    if (!normalizedSiteId || !normalizedSn) {
        return;
    }

    const site = findAdmsSiteById(normalizedSiteId);
    const allowedDeviceSns = Array.isArray(site?.allowedDeviceSns) ? site.allowedDeviceSns : [];
    if (!site || !allowedDeviceSns.includes(normalizedSn)) {
        const error = new Error('Dispositivo no permitido para esta sede');
        error.statusCode = 400;
        error.details = {
            ok: false,
            error: 'Dispositivo no permitido para esta sede',
            siteId: normalizedSiteId,
            targetDeviceSn: normalizedSn
        };
        throw error;
    }
}

function normalizeRecordsScopeValue(value) {
    return String(value || '').trim();
}

function getRecordsScopeFilters(req) {
    const scope = normalizeRecordsScopeValue(req.query.scope).toLowerCase();
    const siteId = normalizeRecordsScopeValue(req.query.siteId);
    const targetDeviceSn = normalizeRecordsScopeValue(req.query.targetDeviceSn);
    const sn = normalizeRecordsScopeValue(req.query.sn);
    const activeSn = targetDeviceSn || sn;

    return {
        scope,
        scopeAll: scope === 'all' || (!siteId && !targetDeviceSn && !sn),
        siteId,
        targetDeviceSn,
        sn,
        activeSn
    };
}

function recordHasValue(record, fields = []) {
    return fields.some(field => normalizeRecordsScopeValue(record?.[field]));
}

function recordMatchesValue(record, fields = [], expectedValue) {
    const expected = normalizeRecordsScopeValue(expectedValue);
    if (!expected) {
        return true;
    }

    return fields.some(field => normalizeRecordsScopeValue(record?.[field]) === expected);
}

function matchesScopedRecord(record, filters, options = {}) {
    if (filters.scopeAll) {
        return true;
    }

    const snFields = Array.isArray(options.snFields) ? options.snFields : [];
    const siteIdFields = Array.isArray(options.siteIdFields) ? options.siteIdFields : [];
    const hasSn = recordHasValue(record, snFields);
    const hasSiteId = recordHasValue(record, siteIdFields);

    if (!hasSn && !hasSiteId) {
        return false;
    }

    if (filters.activeSn) {
        if (!hasSn || !recordMatchesValue(record, snFields, filters.activeSn)) {
            return false;
        }
    }

    if (filters.siteId && !filters.activeSn && !hasSiteId) {
        return false;
    }

    if (filters.siteId && hasSiteId && !recordMatchesValue(record, siteIdFields, filters.siteId)) {
        return false;
    }

    return true;
}

function buildDeleteAuditReadModel(filters) {
    const auditPath = path.join(dataDir, 'adms', 'delete-audit.jsonl');
    if (!fs.existsSync(auditPath)) {
        return [];
    }

    const queueByCommandId = new Map(readAdmsCommandQueue().map(entry => [String(entry.commandId || ''), entry]));
    return readJsonLinesFile(auditPath)
        .map(entry => {
            const queueEntry = queueByCommandId.get(String(entry.deviceDeleteCommandId || '')) || null;
            return {
                ...entry,
                targetDeviceSn: entry.targetDeviceSn || queueEntry?.targetDeviceSn || null,
                siteId: entry.siteId || queueEntry?.siteId || null
            };
        })
        .filter(entry => matchesScopedRecord(entry, filters, { snFields: ['targetDeviceSn'], siteIdFields: ['siteId'] }))
        .reverse();
}

function buildAdmsCommandsReadModel(filters = {}, options = {}) {
    const pin = normalizePin(options.pin);
    const commandId = normalizeRecordsScopeValue(options.commandId);
    const commandType = normalizeRecordsScopeValue(options.commandType).toUpperCase();
    const status = normalizeRecordsScopeValue(options.status);
    const sentCommands = readJsonLinesFile(admsCommandSentLogPath);
    const resultCommands = readJsonLinesFile(admsCommandResultsLogPath);
    const queueEntries = readAdmsCommandQueue();
    const commands = [];

    const getLogicalCommandType = (commandText, queueEntry) => {
        if (queueEntry && queueEntry.commandType) {
            return String(queueEntry.commandType);
        }
        const inferred = inferAdmsCommandType(commandText);
        if (inferred && inferred !== 'OTHER') {
            return inferred;
        }
        if (/DELETE\s+USERINFO/i.test(commandText) || /DELETE_USERINFO/i.test(commandText)) {
            return 'DELETE_USERINFO';
        }
        return 'UNKNOWN';
    };

    for (const cmd of sentCommands) {
        const commandText = String(cmd.command || cmd.commandPreview || '');
        const normalizedCommandId = normalizeRecordsScopeValue(cmd.commandId);
        const queueEntry = normalizedCommandId
            ? queueEntries.find(entry => String(entry.commandId) === normalizedCommandId)
            : null;
        const logicalCommandType = getLogicalCommandType(commandText, queueEntry);
        const resultMatches = normalizedCommandId
            ? resultCommands.filter(entry => String(entry.commandId || entry.id || '') === normalizedCommandId)
            : [];
        const result = resultMatches.length > 0 ? resultMatches[resultMatches.length - 1] : null;

        let cmdStatus = 'legacy_sin_resultado';
        let statusSource = 'legacy';
        let resolvedReturnCode = null;
        let acknowledgedAt = null;

        if (queueEntry) {
            cmdStatus = String(queueEntry.status || 'queued');
            statusSource = 'queue';
            resolvedReturnCode = queueEntry.returnCode ?? null;
            acknowledgedAt = queueEntry.acknowledgedAt || null;
        } else if (result) {
            const resultReturnCode = result.returnCode ?? result.return ?? null;
            resolvedReturnCode = resultReturnCode;
            acknowledgedAt = result.timestamp || null;
            cmdStatus = String(resultReturnCode) === '0' ? 'accepted' : 'failed';
            statusSource = 'results_log';
        }

        const commandRecord = {
            commandId: normalizedCommandId,
            pin: String((queueEntry && queueEntry.pin) || cmd.pin || ''),
            commandType: logicalCommandType,
            targetDeviceSn: normalizeRecordsScopeValue((queueEntry && queueEntry.targetDeviceSn) || cmd.targetDeviceSn),
            ackDeviceSn: normalizeRecordsScopeValue((queueEntry && queueEntry.ackDeviceSn) || (result && result.sn) || cmd.sn),
            requestDeviceSn: normalizeRecordsScopeValue((queueEntry && queueEntry.requestDeviceSn) || cmd.requestDeviceSn),
            siteId: normalizeRecordsScopeValue((queueEntry && queueEntry.siteId) || cmd.siteId),
            command: commandText,
            sentAt: cmd.timestamp,
            status: cmdStatus,
            statusSource,
            returnCode: resolvedReturnCode,
            acknowledgedAt,
            result: result ? (result.result || result.rawLine || result.body || null) : null,
            error: result ? result.error : null
        };

        if (pin && String(commandRecord.pin || '') !== pin) continue;
        if (commandId && commandRecord.commandId !== commandId) continue;
        if (commandType && logicalCommandType !== commandType) continue;
        if (status && commandRecord.status !== status) continue;
        if (!matchesScopedRecord(commandRecord, filters, { snFields: ['targetDeviceSn', 'ackDeviceSn', 'requestDeviceSn'], siteIdFields: ['siteId'] })) continue;

        commands.push(commandRecord);
    }

    return commands;
}

function buildScopedPersonPins(filters) {
    if (filters.scopeAll) {
        return null;
    }

    const pins = new Set();

    readLatestAdmsPersons()
        .filter(person => matchesScopedRecord(person, filters, { snFields: ['targetDeviceSn'], siteIdFields: ['siteId'] }))
        .forEach(person => {
            const pin = normalizePin(person.pin);
            if (pin) {
                pins.add(pin);
            }
        });

    buildAdmsCommandsReadModel(filters).forEach(command => {
        const pin = normalizePin(command.pin);
        if (pin) {
            pins.add(pin);
        }
    });

    readAttendanceEntries({ sn: filters.activeSn, siteId: filters.siteId, limit: 0 }).forEach(entry => {
        const pin = normalizePin(entry.pin);
        if (pin) {
            pins.add(pin);
        }
    });

    return pins;
}

function filterPendingSyncItems(filters) {
    const pendingItems = getPendingSyncItems();
    if (filters.scopeAll) {
        return pendingItems;
    }

    const pendingCommands = (Array.isArray(pendingItems.pendingCommands) ? pendingItems.pendingCommands : [])
        .filter(entry => matchesScopedRecord(entry, filters, { snFields: ['targetDeviceSn', 'ackDeviceSn', 'requestDeviceSn'], siteIdFields: ['siteId'] }));
    const allowedPins = new Set(pendingCommands.map(entry => normalizePin(entry.pin)).filter(Boolean));
    const pendingPersons = (Array.isArray(pendingItems.pendingPersons) ? pendingItems.pendingPersons : [])
        .filter(entry => allowedPins.has(normalizePin(entry.pin)));

    return { pendingCommands, pendingPersons };
}

function buildBiodataSummary(filters) {
    return readJsonLinesFile(admsBiodataLogPath)
        .filter(entry => matchesScopedRecord(entry, filters, { snFields: ['sn', 'targetDeviceSn', 'deviceSn'], siteIdFields: ['siteId'] }))
        .map(entry => ({
            pin: entry.pin,
            type: entry.type,
            majorVer: entry.majorVer,
            minorVer: entry.minorVer,
            index: entry.index,
            timestamp: entry.timestamp,
            hasTmp: !!entry.tmp,
            siteId: entry.siteId || null,
            sn: entry.sn || entry.targetDeviceSn || entry.deviceSn || null
        }));
}

function buildPhotosSummary(filters) {
    const photos = [];
    const files = fs.readdirSync(facesUploadsDir);
    const photoMetadataByPin = new Map(
        readLatestAdmsPersons()
            .filter(entry => normalizeRecordsScopeValue(entry.siteId) || normalizeRecordsScopeValue(entry.targetDeviceSn))
            .map(entry => [String(entry.pin), entry])
    );

    for (const file of files) {
        if (!file.endsWith('.jpg')) continue;
        const pinMatch = file.match(/^(\d+)\.jpg$/);
        if (!pinMatch) continue;

        const pin = pinMatch[1];
        const filePath = path.join(facesUploadsDir, file);
        const stats = fs.statSync(filePath);
        const metadata = photoMetadataByPin.get(pin) || null;
        const photoRecord = {
            pin,
            fileName: file,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            siteId: metadata?.siteId || null,
            sn: metadata?.targetDeviceSn || null
        };

        if (!matchesScopedRecord(photoRecord, filters, { snFields: ['sn'], siteIdFields: ['siteId'] })) {
            continue;
        }
        photos.push(photoRecord);
    }

    return photos;
}

function resolveCommandTargetMetadata(source = {}) {
    const requestedSn = String(source.targetDeviceSn || '').trim() || resolveDefaultTargetDeviceSn();
    const deviceConfig = getDeviceConfigBySn(requestedSn);
    return {
        targetDeviceSn: deviceConfig.sn || DEFAULT_TARGET_DEVICE_SN,
        deviceName: deviceConfig.deviceName || deviceConfig.name || DEFAULT_DEVICE_NAME,
        siteId: null,
        locationName: ''
    };
}

function resolveQueueEntryTargetDeviceSn(entry) {
    return String(entry?.targetDeviceSn || '').trim() || DEFAULT_TARGET_DEVICE_SN;
}

function readAdmsCommandSequenceState() {
    if (!fs.existsSync(admsCommandSequencePath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(admsCommandSequencePath, 'utf8'));
        const nextCommandId = parseInteger(parsed.nextCommandId, NaN);
        return Number.isFinite(nextCommandId) && nextCommandId > 0
            ? { nextCommandId, updatedAt: parsed.updatedAt || null }
            : null;
    } catch (_error) {
        return null;
    }
}

function collectAdmsCommandIdsFromJsonl(filePath, candidateFields) {
    return readJsonLinesFile(filePath)
        .flatMap(entry => candidateFields.map(field => parseInteger(entry[field], NaN)))
        .filter(value => Number.isFinite(value) && value > 0);
}

function computeNextAdmsCommandId() {
    const sequenceState = readAdmsCommandSequenceState();
    const queueIds = collectAdmsCommandIdsFromJsonl(admsCommandQueuePath, ['commandId']);
    const sentIds = collectAdmsCommandIdsFromJsonl(admsCommandSentLogPath, ['commandId']);
    const resultIds = collectAdmsCommandIdsFromJsonl(admsCommandResultsLogPath, ['commandId', 'id']);
    const sequenceIds = sequenceState ? [sequenceState.nextCommandId - 1] : [];
    const maxCommandId = Math.max(0, ...sequenceIds, ...queueIds, ...sentIds, ...resultIds);
    return maxCommandId + 1;
}

function saveAdmsCommandSequence(nextCommandId) {
    fs.writeFileSync(admsCommandSequencePath, JSON.stringify({
        nextCommandId,
        updatedAt: new Date().toISOString()
    }, null, 2));
}

function initializeAdmsCommandSequence() {
    const nextCommandId = computeNextAdmsCommandId();
    saveAdmsCommandSequence(nextCommandId);
    return nextCommandId;
}

function allocateAdmsCommandId() {
    const commandId = admsCommandId;
    admsCommandId += 1;
    saveAdmsCommandSequence(admsCommandId);
    return commandId;
}

function inferAdmsCommandType(command) {
    const text = String(command || '');
    if (/DELETE\s+USERINFO/i.test(text) || /DELETE_USERINFO/i.test(text)) {
        return 'DELETE_USERINFO';
    }
    if (/DATA\s+UPDATE\s+USERINFO/i.test(text)) {
        return 'USERINFO';
    }
    if (/DATA\s+UPDATE\s+BIOPHOTO/i.test(text)) {
        return 'BIOPHOTO';
    }
    if (/DATA\s+UPDATE\s+BIODATA/i.test(text)) {
        return 'BIODATA';
    }
    if (/DATA\s+QUERY\s+BIODATA/i.test(text)) {
        return 'BIODATA';
    }
    return 'OTHER';
}

function readAdmsCommandQueue() {
    return readJsonLinesFile(admsCommandQueuePath)
        .map(entry => ({
            ...entry,
            commandId: String(entry.commandId || ''),
            commandType: String(entry.commandType || inferAdmsCommandType(entry.command)),
            pin: String(entry.pin || ''),
            command: String(entry.command || ''),
            createdAt: String(entry.createdAt || ''),
            sentAt: entry.sentAt || null,
            acknowledgedAt: entry.acknowledgedAt || null,
            returnCode: entry.returnCode || null,
            status: String(entry.status || 'queued'),
            targetDeviceSn: resolveQueueEntryTargetDeviceSn(entry),
            siteId: String(entry.siteId || DEFAULT_SITE_ID),
            deviceName: String(entry.deviceName || ''),
            locationName: String(entry.locationName || ''),
            ackDeviceSn: entry.ackDeviceSn || null,
            requestDeviceSn: entry.requestDeviceSn || null,
            rawLine: entry.rawLine || null,
            purpose: entry.purpose || null
        }));
}

function saveAdmsCommandQueue(entries) {
    const fileContent = entries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(admsCommandQueuePath, fileContent ? `${fileContent}\n` : '');
}

function updateDeleteAuditForDeviceCommand(commandId, updates) {
    const auditPath = path.join(dataDir, 'adms', 'delete-audit.jsonl');
    const auditEntries = readJsonLinesFile(auditPath);
    let found = false;

    const updatedEntries = auditEntries.map(entry => {
        if (String(entry.deviceDeleteCommandId || '') !== String(commandId || '')) {
            return entry;
        }

        found = true;
        return {
            ...entry,
            ...updates
        };
    });

    if (!found) {
        logStore.warn('adms.delete-audit.missing-command', {
            commandId: String(commandId || '')
        });
        return false;
    }

    const fileContent = updatedEntries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(auditPath, fileContent ? `${fileContent}\n` : '');
    return true;
}

function appendAdmsCommandQueueEntry(entry) {
    appendJsonLine(admsCommandQueuePath, entry);
    void insertMysqlAdmsCommand(entry);
}

async function insertMysqlAdmsCommand(entry) {
    try {
        const commandId = normalizeUnsignedBigIntText(entry?.commandId);
        if (!commandId) {
            logStore.warn('adms.command.mysql-insert.skipped', {
                reason: 'invalid-command-id',
                commandId: entry?.commandId || null
            });
            return;
        }

        const references = await resolveMysqlAdmsCommandReferences(entry);
        const commandType = String(entry.commandType || inferAdmsCommandType(entry.command)).trim() || 'UNKNOWN';
        const targetDeviceSn = normalizeRecordsScopeValue(entry.targetDeviceSn || resolveQueueEntryTargetDeviceSn(entry)) || null;
        const status = normalizeAdmsCommandStatusForMysql(entry.status);

        await db.query(`
            INSERT INTO adms_commands (
                id,
                entidad_id,
                dispositivo_id,
                persona_id,
                pin_dispositivo,
                command_type,
                command_text,
                purpose,
                status,
                return_code,
                sent_at,
                acknowledged_at,
                ack_device_sn,
                request_device_sn,
                target_device_sn,
                raw_result,
                error,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                entidad_id = VALUES(entidad_id),
                dispositivo_id = VALUES(dispositivo_id),
                persona_id = VALUES(persona_id),
                pin_dispositivo = VALUES(pin_dispositivo),
                command_type = VALUES(command_type),
                command_text = VALUES(command_text),
                purpose = VALUES(purpose),
                status = VALUES(status),
                return_code = VALUES(return_code),
                sent_at = VALUES(sent_at),
                acknowledged_at = VALUES(acknowledged_at),
                ack_device_sn = VALUES(ack_device_sn),
                request_device_sn = VALUES(request_device_sn),
                target_device_sn = VALUES(target_device_sn),
                raw_result = VALUES(raw_result),
                error = VALUES(error)
        `, [
            commandId,
            references.entidadId,
            references.dispositivoId,
            references.personaId,
            normalizePin(entry.pin) || null,
            commandType,
            String(entry.command || ''),
            normalizeRecordsScopeValue(entry.purpose) || null,
            status,
            entry.returnCode == null ? null : String(entry.returnCode),
            toMysqlDateOrNull(entry.sentAt),
            toMysqlDateOrNull(entry.acknowledgedAt),
            normalizeRecordsScopeValue(entry.ackDeviceSn) || null,
            normalizeRecordsScopeValue(entry.requestDeviceSn) || null,
            targetDeviceSn,
            entry.rawLine == null ? null : String(entry.rawLine),
            entry.error == null ? null : String(entry.error),
            toMysqlDateOrNull(entry.createdAt) || new Date()
        ]);
    } catch (error) {
        logStore.error('adms.command.mysql-insert.error', {
            commandId: entry?.commandId || null,
            commandType: entry?.commandType || null,
            targetDeviceSn: entry?.targetDeviceSn || null,
            error: error.message
        });
    }
}

async function resolveMysqlAdmsCommandReferences(entry = {}) {
    const pin = normalizePin(entry.pin);
    const targetDeviceSn = normalizeRecordsScopeValue(entry.targetDeviceSn || resolveQueueEntryTargetDeviceSn(entry));
    let dispositivoId = normalizePositiveIntegerId(entry.dispositivo_id || entry.deviceId);
    let entidadId = normalizePositiveIntegerId(entry.entidad_id || entry.entidadId || entry.entityId);
    let personaId = normalizePositiveIntegerId(entry.persona_id || entry.personId);

    if ((!dispositivoId || !entidadId) && targetDeviceSn) {
        const device = await readMysqlDeviceBySerial(targetDeviceSn);
        dispositivoId = dispositivoId || normalizePositiveIntegerId(device?.id);
        entidadId = entidadId || normalizePositiveIntegerId(device?.entidad_id);
    }

    if (!personaId && pin) {
        personaId = await resolveMysqlPersonaIdForCommand({
            pin,
            dispositivoId,
            entidadId
        });
    }

    return {
        entidadId,
        dispositivoId,
        personaId
    };
}

async function resolveMysqlPersonaIdForCommand({ pin, dispositivoId = null, entidadId = null }) {
    try {
        const clauses = ['pd.pin_dispositivo = ?'];
        const params = [pin];

        if (dispositivoId) {
            clauses.push('pd.dispositivo_id = ?');
            params.push(dispositivoId);
        }

        if (entidadId) {
            clauses.push('p.entidad_id = ?');
            params.push(entidadId);
        }

        const [rows] = await db.query(`
            SELECT p.id
            FROM persona_dispositivos pd
            INNER JOIN personas p ON p.id = pd.persona_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY pd.updated_at DESC, pd.id DESC
            LIMIT 1
        `, params);

        return normalizePositiveIntegerId(Array.isArray(rows) && rows[0] ? rows[0].id : null);
    } catch (error) {
        logStore.warn('adms.command.mysql-reference.skipped', {
            pin,
            dispositivoId,
            entidadId,
            error: error.message
        });
        return null;
    }
}

function normalizeUnsignedBigIntText(value) {
    const raw = String(value || '').trim();
    if (!/^\d+$/.test(raw)) {
        return null;
    }

    try {
        const parsed = BigInt(raw);
        return parsed > 0n && parsed <= 18446744073709551615n ? raw : null;
    } catch (_error) {
        return null;
    }
}

function normalizeAdmsCommandStatusForMysql(value) {
    const status = String(value || '').trim();
    const allowedStatuses = new Set(['queued', 'retry_pending', 'sent_waiting_ack', 'accepted', 'failed']);
    return allowedStatuses.has(status) ? status : 'queued';
}

function toMysqlDateOrNull(value) {
    if (!value) {
        return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function refreshPendingCommandsMemory() {
    comandosPendientes = readAdmsCommandQueue()
        .filter(entry => ['queued', 'retry_pending', 'sent_waiting_ack'].includes(entry.status))
        .map(entry => entry.command);
}

function findAdmsCommandQueueEntry(commandId) {
    return readAdmsCommandQueue().find(entry => String(entry.commandId) === String(commandId));
}

function readAdmsCommandStatus(commandId) {
    const id = String(commandId || '').trim();
    const entry = findAdmsCommandQueueEntry(id);

    if (!entry) {
        return {
            id,
            found: false,
            status: 'unknown',
            reason: 'Comando no encontrado'
        };
    }

    return {
        id,
        found: true,
        status: String(entry.status || 'unknown'),
        returnCode: entry.returnCode ?? null,
        cmd: String(entry.command || '').split(':').slice(2).join(':').split(' ')[0] || null,
        rawLine: entry.rawLine || null,
        timestamp: entry.acknowledgedAt || entry.sentAt || entry.createdAt || null,
        commandType: entry.commandType || null,
        pin: entry.pin || null,
        targetDeviceSn: entry.targetDeviceSn || DEFAULT_TARGET_DEVICE_SN,
        siteId: entry.siteId || DEFAULT_SITE_ID,
        deviceName: entry.deviceName || null,
        locationName: entry.locationName || null,
        ackDeviceSn: entry.ackDeviceSn || null,
        createdAt: entry.createdAt || null,
        sentAt: entry.sentAt || null,
        acknowledgedAt: entry.acknowledgedAt || null
    };
}

async function readMysqlAdmsCommandStatus(commandId) {
    const id = normalizeUnsignedBigIntText(commandId);
    if (!id) {
        return null;
    }

    const [rows] = await db.query(`
        SELECT
            id,
            command_type,
            pin_dispositivo,
            status,
            return_code,
            target_device_sn,
            request_device_sn,
            ack_device_sn,
            sent_at,
            acknowledged_at,
            raw_result,
            error,
            created_at,
            updated_at
        FROM adms_commands
        WHERE id = ?
        LIMIT 1
    `, [id]);

    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row) {
        return null;
    }

    return {
        commandId: String(row.id),
        commandType: row.command_type || null,
        pin: row.pin_dispositivo || null,
        status: row.status || null,
        returnCode: row.return_code ?? null,
        targetDeviceSn: row.target_device_sn || null,
        requestDeviceSn: row.request_device_sn || null,
        ackDeviceSn: row.ack_device_sn || null,
        sentAt: row.sent_at || null,
        acknowledgedAt: row.acknowledged_at || null,
        rawResult: row.raw_result || null,
        error: row.error || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        source: 'mysql'
    };
}

async function updateMysqlAdmsCommandAck(commandId, updates = {}) {
    try {
        const id = normalizeUnsignedBigIntText(commandId);
        if (!id) {
            logStore.warn('adms.command.mysql-ack.missing', {
                commandId: commandId || null
            });
            return;
        }

        const [result] = await db.query(`
            UPDATE adms_commands
            SET status = ?,
                return_code = ?,
                acknowledged_at = ?,
                ack_device_sn = ?,
                raw_result = ?,
                error = ?
            WHERE id = ?
        `, [
            normalizeAdmsCommandStatusForMysql(updates.status),
            updates.returnCode == null ? null : String(updates.returnCode),
            toMysqlDateOrNull(updates.acknowledgedAt) || new Date(),
            normalizeRecordsScopeValue(updates.ackDeviceSn) || null,
            updates.rawLine == null ? null : String(updates.rawLine),
            updates.error == null ? null : String(updates.error),
            id
        ]);

        if (!result || result.affectedRows === 0) {
            logStore.warn('adms.command.mysql-ack.missing', {
                commandId: id
            });
        }
    } catch (error) {
        logStore.error('adms.command.mysql-ack.error', {
            commandId: commandId || null,
            status: updates.status || null,
            returnCode: updates.returnCode ?? null,
            ackDeviceSn: updates.ackDeviceSn || null,
            error: error.message
        });
    }
}

function updateAdmsCommandQueueEntry(commandId, updates) {
    const queue = readAdmsCommandQueue();
    let found = false;
    const now = new Date().toISOString();
    const updated = queue.map(entry => {
        if (String(entry.commandId) !== String(commandId)) {
            return entry;
        }

        found = true;
        return {
            ...entry,
            ...updates,
            updatedAt: now
        };
    });

    if (found) {
        saveAdmsCommandQueue(updated);
        refreshPendingCommandsMemory();
    }

    return updated.find(entry => String(entry.commandId) === String(commandId)) || null;
}

function enqueueAdmsCommandEntry({ commandId, commandType, pin, command, ...extraFields }) {
    const targetMetadata = resolveCommandTargetMetadata(extraFields);
    const entry = {
        commandId: String(commandId),
        commandType: String(commandType || inferAdmsCommandType(command)),
        pin: String(pin || ''),
        command: String(command || ''),
        targetDeviceSn: targetMetadata.targetDeviceSn,
        siteId: targetMetadata.siteId,
        deviceName: targetMetadata.deviceName,
        locationName: targetMetadata.locationName,
        createdAt: new Date().toISOString(),
        sentAt: null,
        acknowledgedAt: null,
        returnCode: null,
        status: 'queued',
        ...extraFields
    };
    appendAdmsCommandQueueEntry(entry);
    if (!comandosPendientes.includes(entry.command)) {
        comandosPendientes.push(entry.command);
    }
    return entry;
}

function getPendingAdmsCommands() {
    return readAdmsCommandQueue().filter(entry => ['queued', 'retry_pending', 'sent_waiting_ack'].includes(entry.status));
}

function computeDeviceSyncStatusForPin(pin) {
    const commands = readAdmsCommandQueue().filter(entry => String(entry.pin) === String(pin));
    if (commands.length === 0) {
        return 'unknown';
    }
    if (commands.some(entry => entry.status === 'failed')) {
        return 'failed_on_device';
    }
    if (commands.every(entry => entry.status === 'accepted')) {
        return 'accepted_by_device';
    }
    return 'pending_device';
}

function updateAdmsPersonSyncStatus(pin, deviceSyncStatus) {
    const previous = readLatestAdmsPersonByPin(pin);
    if (!previous) {
        return;
    }

    appendJsonLine(admsPersonsLogPath, {
        nuip: previous.nuip || null,
        pin,
        name: previous.name,
        photo: previous.photo,
        status: previous.status || 'activo',
        imageSize: previous.imageSize,
        userCommandId: previous.userCommandId || null,
        biophotoCommandId: previous.biophotoCommandId || null,
        biodataCommandId: previous.biodataCommandId || null,
        deviceSyncStatus,
        attendanceConfirmed: previous.attendanceConfirmed || false,
        siteId: previous.siteId || null,
        targetDeviceSn: previous.targetDeviceSn || null,
        createdAt: previous.createdAt,
        updatedAt: new Date().toISOString()
    });
}

function markAttendanceConfirmedForPin(pin) {
    const previous = readLatestAdmsPersonByPin(pin);
    if (!previous || previous.attendanceConfirmed) {
        return;
    }

    appendJsonLine(admsPersonsLogPath, {
        nuip: previous.nuip || null,
        pin,
        name: previous.name,
        photo: previous.photo,
        status: previous.status || 'activo',
        imageSize: previous.imageSize,
        userCommandId: previous.userCommandId || null,
        biophotoCommandId: previous.biophotoCommandId || null,
        biodataCommandId: previous.biodataCommandId || null,
        deviceSyncStatus: previous.deviceSyncStatus || 'pending_device',
        attendanceConfirmed: true,
        siteId: previous.siteId || null,
        targetDeviceSn: previous.targetDeviceSn || null,
        createdAt: previous.createdAt,
        updatedAt: new Date().toISOString()
    });
}

async function getAdmsSyncStatus(pin) {
    const localPerson = readLatestAdmsPersonByPin(pin);
    const queueCommands = readAdmsCommandQueue().filter(entry => String(entry.pin) === String(pin));
    const attendanceConfirmed = readAttendanceEntries({ pin }).length > 0;
    let personExistsInDb = false;

    try {
        const [rows] = await db.query('SELECT COUNT(*) as count FROM usuarios WHERE pin = ?', [pin]);
        personExistsInDb = rows[0] && rows[0].count > 0;
    } catch (_error) {
        personExistsInDb = false;
    }

    return {
        pin,
        personExistsInDb,
        personExistsLocal: Boolean(localPerson),
        deviceSyncStatus: localPerson ? computeDeviceSyncStatusForPin(pin) : 'unknown',
        attendanceConfirmed,
        commands: queueCommands.map(entry => ({
            commandType: entry.commandType,
            targetDeviceSn: entry.targetDeviceSn || DEFAULT_TARGET_DEVICE_SN,
            siteId: entry.siteId || DEFAULT_SITE_ID,
            status: entry.status,
            createdAt: entry.createdAt,
            sentAt: entry.sentAt,
            acknowledgedAt: entry.acknowledgedAt,
            returnCode: entry.returnCode
        }))
    };
}

function getPendingSyncItems() {
    const pendingCommands = getPendingAdmsCommands();
    const persons = Array.from(new Set(pendingCommands.map(entry => String(entry.pin))))
        .map(pin => {
            const localPerson = readLatestAdmsPersonByPin(pin);
            return {
                pin,
                deviceSyncStatus: localPerson ? computeDeviceSyncStatusForPin(pin) : 'unknown',
                attendanceConfirmed: localPerson ? Boolean(localPerson.attendanceConfirmed) : false,
                personExistsLocal: Boolean(localPerson)
            };
        });

    return {
        pendingCommands,
        pendingPersons: persons
    };
}

function retryPendingAdmsCommands(pin) {
    const queue = readAdmsCommandQueue();
    let changed = false;
    const now = new Date().toISOString();
    const updated = queue.map(entry => {
        if (pin && String(entry.pin) !== String(pin)) {
            return entry;
        }
        if (['queued', 'sent_waiting_ack', 'retry_pending'].includes(entry.status)) {
            if (entry.status !== 'retry_pending') {
                changed = true;
            }
            return {
                ...entry,
                status: 'retry_pending',
                sentAt: null,
                acknowledgedAt: null,
                updatedAt: now
            };
        }
        return entry;
    });
    if (changed) {
        saveAdmsCommandQueue(updated);
        refreshPendingCommandsMemory();
    }
    return getPendingAdmsCommands();
}

function buildAdmsCommandPreview(commandText) {
    const entries = readJsonLinesFile(admsTrafficLogPath);
    let latestMatch = null;

    for (const entry of entries) {
        if (!entry || !String(entry.originalUrl || '').includes('/iclock/devicecmd')) {
            continue;
        }

        const queryFields = normalizeFieldMap(entry.query);
        const bodyLines = String(entry.body || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        const linesToCheck = bodyLines.length > 0 ? bodyLines : [''];

        for (const rawLine of linesToCheck) {
            const bodyFields = parseAdmsFieldMap(rawLine);
            const entryId = firstNonEmpty(bodyFields.ID, queryFields.ID);

            if (entryId !== String(id)) {
                continue;
            }

            const returnCode = firstNonEmpty(bodyFields.Return, queryFields.Return);
            const cmd = firstNonEmpty(bodyFields.CMD, queryFields.CMD);
            const candidate = {
                id: String(id),
                found: true,
                status: String(returnCode) === '0' ? 'accepted' : 'failed',
                returnCode,
                cmd,
                rawLine: rawLine || JSON.stringify(entry.query || {}),
                timestamp: entry.timestamp || null
            };

            if (!latestMatch || String(candidate.timestamp || '') > String(latestMatch.timestamp || '')) {
                latestMatch = candidate;
            }
        }
    }

    if (latestMatch) {
        return latestMatch;
    }

    return {
        id: String(id),
        found: false,
        status: 'pending',
        returnCode: null,
        cmd: null,
        rawLine: null,
        timestamp: null
    };
}

function persistAdmsPerson({ nuip, pin, name, photo, imageSize, userCommandId, biophotoCommandId, biodataCommandId, siteId, targetDeviceSn }) {
    const now = new Date().toISOString();
    const previous = readLatestAdmsPersonByPin(pin);

    appendJsonLine(admsPersonsLogPath, {
        nuip: normalizeNuip(nuip) || previous?.nuip || null,
        pin,
        name,
        photo,
        status: previous?.status || 'activo',
        imageSize,
        userCommandId: userCommandId || previous?.userCommandId || null,
        biophotoCommandId: biophotoCommandId || previous?.biophotoCommandId || null,
        biodataCommandId: biodataCommandId || previous?.biodataCommandId || null,
        deviceSyncStatus: previous?.deviceSyncStatus || 'pending_device',
        attendanceConfirmed: previous?.attendanceConfirmed || false,
        siteId: siteId || previous?.siteId || null,
        targetDeviceSn: targetDeviceSn || previous?.targetDeviceSn || null,
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now
    });
}

async function syncEnrolledPersonState({ pin, name, photo }) {
    if (!await mysqlTableExists('usuarios')) {
        logStore.warn('legacy.usuarios.disabled', {
            route: 'syncEnrolledPersonState'
        });
        return;
    }

    await db.query(
        `INSERT INTO usuarios (pin, nombre, foto, estado)
         VALUES (?, ?, ?, 'activo')
         ON DUPLICATE KEY UPDATE
             nombre = VALUES(nombre),
             foto = VALUES(foto),
             estado = 'activo',
             updated_at = CURRENT_TIMESTAMP`,
        [pin, name, photo]
    );
}

function readLatestAdmsPersons() {
    const latestByPin = new Map();
    for (const entry of readJsonLinesFile(admsPersonsLogPath)) {
        if (!entry || !entry.pin) {
            continue;
        }

        latestByPin.set(entry.pin, {
            nuip: normalizeNuip(entry.nuip) || null,
            pin: entry.pin,
            name: entry.name,
            photo: entry.photo,
            status: entry.status || 'activo',
            imageSize: entry.imageSize,
            userCommandId: entry.userCommandId || null,
            biophotoCommandId: entry.biophotoCommandId || null,
            biodataCommandId: entry.biodataCommandId || null,
            deviceSyncStatus: entry.deviceSyncStatus || 'pending_device',
            attendanceConfirmed: Boolean(entry.attendanceConfirmed),
            siteId: entry.siteId || null,
            targetDeviceSn: entry.targetDeviceSn || null,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt
        });
    }

    return Array.from(latestByPin.values())
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function readLatestAdmsPersonByPin(pin) {
    return readLatestAdmsPersons().find(entry => entry.pin === pin) || null;
}

function readLatestAdmsPersonByNuip(nuip, filters = null) {
    const normalizedNuip = normalizeNuip(nuip);
    if (!normalizedNuip) {
        return null;
    }

    const records = readLatestAdmsPersons().filter(entry => String(entry.nuip || '') === normalizedNuip);
    if (records.length === 0) {
        return null;
    }

    if (!filters) {
        return records[0];
    }

    return records.find(entry => matchesScopedRecord(entry, filters, {
        snFields: ['targetDeviceSn'],
        siteIdFields: ['siteId']
    })) || records[0];
}

async function readDbPersonByPin(pin) {
    try {
        const [rows] = await db.query(
            'SELECT pin, nombre, estado, updated_at AS updatedAt FROM usuarios WHERE pin = ? LIMIT 1',
            [pin]
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        return row ? {
            pin: normalizePin(row.pin),
            name: row.nombre || null,
            status: row.estado || 'activo',
            updatedAt: row.updatedAt || null
        } : null;
    } catch (_error) {
        return null;
    }
}

async function ensureLegacyUsuariosTable(routeId = 'legacy') {
    if (await mysqlTableExists('usuarios')) {
        return;
    }

    const error = new Error('La ruta legacy no está habilitada porque la tabla usuarios no existe en el schema MVP');
    error.statusCode = 503;
    error.code = 'LEGACY_ROUTE_DISABLED';
    error.details = { routeId };
    throw error;
}

function normalizePositiveIntegerId(value) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return null;
    }

    const parsed = Number.parseInt(String(value).trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizePersonStatus(value, fallback = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return fallback;
    }

    return raw === 'activo' || raw === 'inactivo' ? raw : '';
}

function buildPersonFullName(nombres, apellidos) {
    return [String(nombres || '').trim(), String(apellidos || '').trim()]
        .filter(Boolean)
        .join(' ')
        .trim();
}

function slugifyEntityCode(value) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || '';
}

async function buildMysqlPersonPayloadFromPublicBody(body = {}, options = {}) {
    const payload = {};
    const requireName = options.requireName === true;
    const rawName = body.name !== undefined ? String(body.name || '').trim() : '';

    if (body.name !== undefined) {
        if (!rawName && requireName) {
            const error = new Error('name requerido');
            error.statusCode = 400;
            throw error;
        }

        if (rawName) {
            payload.nombres = rawName;
            payload.nombre_completo = rawName;
        }
    }

    if (body.nombres !== undefined) {
        payload.nombres = body.nombres;
    }

    if (body.apellidos !== undefined) {
        payload.apellidos = body.apellidos;
    }

    if (body.nombre_completo !== undefined) {
        payload.nombre_completo = body.nombre_completo;
    }

    if (body.entidad_id !== undefined) {
        payload.entidad_id = body.entidad_id;
    }

    if (body.estado !== undefined) {
        payload.estado = body.estado;
    }

    return payload;
}

function mapMysqlPersonRecord(row, deviceProfiles = []) {
    return {
        id: row.id,
        entidad_id: row.entidad_id,
        nuip: row.nuip,
        nombres: row.nombres,
        apellidos: row.apellidos || null,
        nombre_completo: row.nombre_completo,
        estado: row.estado || 'activo',
        createdAt: row.createdAt || null,
        updatedAt: row.updatedAt || null,
        persona_dispositivos: deviceProfiles
    };
}

function toPublicPerson(person) {
    if (!person) return null;
    const relation = Array.isArray(person.persona_dispositivos) && person.persona_dispositivos.length > 0
        ? person.persona_dispositivos[0]
        : null;

    return {
        nuip: person.nuip,
        name: person.nombre_completo || person.nombres,
        status: person.estado,
        device: relation
            ? {
                serial: relation.numero_serie,
                syncStatus: relation.estado_sync
              }
            : null
    };
}

function toPublicCommand(command) {
    if (!command) return null;
    return {
        id: command.commandId || command.id,
        type: command.commandType || command.type,
        status: command.status,
        returnCode: command.returnCode ?? null,
        nuip: command.pin || null,
        deviceSerial: command.targetDeviceSn || command.requestDeviceSn || command.ackDeviceSn || null,
        sentAt: command.sentAt || null,
        acknowledgedAt: command.acknowledgedAt || null
    };
}

function normalizeDevicePublicStatus(device) {
    const estado = String(device?.estado || '').trim().toLowerCase();
    if (estado === 'inactivo') {
        return 'inactivo';
    }

    return 'activo';
}

function toPublicV2Device(device) {
    if (!device) {
        return null;
    }

    return {
        serial: device.numero_serie || device.serial || null,
        name: device.nombre || device.name || null,
        status: normalizeDevicePublicStatus(device)
    };
}

function toPublicAttendanceRecord(record) {
    if (!record) {
        return null;
    }

    return {
        nuip: record.nuip || record.pin || null,
        timestamp: record.timestamp || null,
        deviceSerial: record.deviceSerial || record.numero_serie || record.sn || null,
        receivedAt: record.receivedAt || record.createdAt || record.loggedAt || null
    };
}

async function listMysqlAttendanceRecords(filters = {}) {
    if (!await mysqlTableExists('asistencias')) {
        return null;
    }

    const clauses = [];
    const params = [];
    const entidadId = normalizePositiveIntegerId(filters.entidad_id);
    const nuip = normalizeNuip(filters.nuip);
    const from = normalizeDateFilter(filters.from);
    const to = normalizeDateFilter(filters.to);
    const limit = normalizeAttendanceLimit(filters.limit || 100);

    if (entidadId) {
        clauses.push('a.entidad_id = ?');
        params.push(entidadId);
    }

    if (nuip) {
        clauses.push('a.nuip = ?');
        params.push(nuip);
    }

    if (from) {
        clauses.push('a.timestamp >= ?');
        params.push(`${from} 00:00:00`);
    }

    if (to) {
        clauses.push('a.timestamp <= ?');
        params.push(`${to} 23:59:59`);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const finalLimit = limit > 0 ? limit : 100;
    params.push(finalLimit);

    const [rows] = await db.query(`
        SELECT
            a.nuip,
            a.timestamp,
            d.numero_serie AS deviceSerial,
            a.received_at AS receivedAt
        FROM asistencias a
        JOIN dispositivos d ON d.id = a.dispositivo_id
        ${whereClause}
        ORDER BY a.timestamp DESC
        LIMIT ?
    `, params);

    return Array.isArray(rows) ? rows : [];
}

function findDisallowedBodyField(body = {}, allowedFields = []) {
    const allowed = new Set(allowedFields);
    return Object.keys(body || {}).find(field => !allowed.has(field)) || '';
}

function toPublicAdminEntity(entity) {
    if (!entity) {
        return null;
    }

    return {
        id: entity.id,
        name: entity.nombre || null,
        code: entity.codigo || null,
        status: entity.estado || 'activo',
        devicesCount: Number(entity.devicesCount || 0),
        apiClientsCount: Number(entity.apiClientsCount || 0),
        createdAt: entity.created_at || entity.createdAt || null,
        updatedAt: entity.updated_at || entity.updatedAt || null
    };
}

function toPublicAdminDevice(device) {
    if (!device) {
        return null;
    }

    return {
        serial: device.numero_serie || null,
        name: device.nombre || null,
        ip: device.ip || null,
        status: normalizeDevicePublicStatus(device),
        entity: device.entidad_id
            ? {
                id: device.entidad_id,
                name: device.entidad_nombre || null
            }
            : null,
        createdAt: device.created_at || device.createdAt || null,
        updatedAt: device.updated_at || device.updatedAt || null
    };
}

async function mysqlTableExists(tableName) {
    const [rows] = await db.query('SHOW TABLES LIKE ?', [String(tableName || '').trim()]);
    return Array.isArray(rows) && rows.length > 0;
}

async function mysqlTableColumnExists(tableName, columnName) {
    const [rows] = await db.query(`
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
        LIMIT 1
    `, [String(tableName || '').trim(), String(columnName || '').trim()]);
    return Array.isArray(rows) && rows.length > 0;
}

async function readMysqlEntityById(entityId) {
    const normalizedId = normalizePositiveIntegerId(entityId);
    if (!normalizedId) {
        return null;
    }

    const [rows] = await db.query(`
        SELECT id, nombre, codigo, estado
        FROM entidades
        WHERE id = ?
        LIMIT 1
    `, [normalizedId]);

    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function assertMysqlEntityIsActive(entityId) {
    const entity = await readMysqlEntityById(entityId);
    if (!entity) {
        const error = new Error('Entidad no encontrada');
        error.statusCode = 404;
        error.code = 'ENTITY_NOT_FOUND';
        throw error;
    }

    if (String(entity.estado || '').trim().toLowerCase() === 'inactivo') {
        const error = new Error('La entidad está inactiva');
        error.statusCode = 403;
        error.code = 'ENTITY_INACTIVE';
        throw error;
    }

    return entity;
}

function normalizeOptionalBoolean(value, fallback = null) {
    if (value === undefined) {
        return fallback;
    }

    if (value === null) {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return fallback;
    }

    if (['1', 'true', 'si', 'sí', 'yes', 'on'].includes(raw)) {
        return true;
    }

    if (['0', 'false', 'no', 'off'].includes(raw)) {
        return false;
    }

    return fallback;
}

function normalizeAdminEnabled(value, fallback = null) {
    if (value === undefined) {
        return fallback;
    }

    if (value === null) {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return fallback;
    }

    if (['1', 'true', 'si', 'sí', 'yes', 'on', 'activo'].includes(raw)) {
        return true;
    }

    if (['0', 'false', 'no', 'off', 'inactivo'].includes(raw)) {
        return false;
    }

    return normalizeOptionalBoolean(value, fallback);
}

async function resolveDefaultEntidadId(explicitEntidadId = null) {
    if (explicitEntidadId) {
        return explicitEntidadId;
    }

    const [rows] = await db.query('SELECT id FROM entidades ORDER BY id ASC LIMIT 1');
    const firstRow = Array.isArray(rows) ? rows[0] : null;
    const resolvedId = normalizePositiveIntegerId(firstRow?.id);

    if (!resolvedId) {
        const error = new Error('No existe una entidad por defecto disponible. Envia entidad_id.');
        error.statusCode = 400;
        throw error;
    }

    return resolvedId;
}

async function readMysqlPersonDeviceProfiles(personIds = []) {
    const normalizedIds = personIds
        .map(value => normalizePositiveIntegerId(value))
        .filter(Boolean);

    if (normalizedIds.length === 0) {
        return new Map();
    }

    const hasPersonaDispositivos = await mysqlTableExists('persona_dispositivos');
    if (!hasPersonaDispositivos) {
        return new Map();
    }

    const hasDispositivos = await mysqlTableExists('dispositivos');
    const selectSerial = hasDispositivos ? ', d.numero_serie' : '';
    const joinDispositivos = hasDispositivos ? ' LEFT JOIN dispositivos d ON d.id = pd.dispositivo_id' : '';
    const placeholders = normalizedIds.map(() => '?').join(',');
    const [rows] = await db.query(`
        SELECT pd.persona_id, pd.dispositivo_id, pd.pin_dispositivo, pd.estado_sync,
               pd.ultimo_comando_id AS ultimo_comando_id${selectSerial}
        FROM persona_dispositivos pd
        ${joinDispositivos}
        WHERE pd.persona_id IN (${placeholders})
        ORDER BY pd.id ASC
    `, normalizedIds);

    const profilesByPersonId = new Map();
    for (const row of rows) {
        const personId = normalizePositiveIntegerId(row.persona_id);
        if (!personId) {
            continue;
        }

        const current = profilesByPersonId.get(personId) || [];
        current.push({
            dispositivo_id: row.dispositivo_id,
            numero_serie: row.numero_serie || null,
            pin_dispositivo: row.pin_dispositivo,
            estado_sync: row.estado_sync || null,
            ultimo_comando_id: row.ultimo_comando_id || null
        });
        profilesByPersonId.set(personId, current);
    }

    return profilesByPersonId;
}

async function listMysqlPersons(filters = {}) {
    const hasPersonasTable = await mysqlTableExists('personas');
    if (!hasPersonasTable) {
        const error = new Error('La tabla personas no existe. Ejecuta la migracion 001_multi_entity_base.sql.');
        error.statusCode = 500;
        throw error;
    }

    const clauses = [];
    const params = [];
    const nuip = normalizeNuip(filters.nuip);
    const entidadId = normalizePositiveIntegerId(filters.entidad_id);
    const estado = normalizePersonStatus(filters.estado);

    if (nuip) {
        clauses.push('nuip = ?');
        params.push(nuip);
    }

    if (entidadId) {
        clauses.push('entidad_id = ?');
        params.push(entidadId);
    }

    if (estado) {
        clauses.push('estado = ?');
        params.push(estado);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await db.query(`
        SELECT id, entidad_id, nuip, nombres, apellidos, nombre_completo,
               estado, created_at AS createdAt, updated_at AS updatedAt
        FROM personas
        ${whereClause}
        ORDER BY updated_at DESC, id DESC
    `, params);
    const profilesByPersonId = await readMysqlPersonDeviceProfiles(rows.map(row => row.id));
    return rows.map(row => mapMysqlPersonRecord(row, profilesByPersonId.get(row.id) || []));
}

async function readMysqlPersonByNuip(nuip, options = {}) {
    const records = await listMysqlPersons({
        nuip,
        entidad_id: options.entidad_id
    });
    return records[0] || null;
}

async function createMysqlPerson(payload = {}) {
    const nuip = normalizeNuip(payload.nuip);
    const nombres = String(payload.nombres || '').trim();
    const apellidos = String(payload.apellidos || '').trim();
    const nombreCompleto = String(payload.nombre_completo || '').trim() || buildPersonFullName(nombres, apellidos);
    const entidadId = await resolveDefaultEntidadId(normalizePositiveIntegerId(payload.entidad_id));
    const estado = normalizePersonStatus(payload.estado, 'activo') || 'activo';

    if (!nuip) {
        const error = new Error('nuip requerido');
        error.statusCode = 400;
        throw error;
    }

    if (!nombres) {
        const error = new Error('nombres requerido');
        error.statusCode = 400;
        throw error;
    }

    if (!nombreCompleto) {
        const error = new Error('nombre_completo invalido');
        error.statusCode = 400;
        throw error;
    }

    try {
        const [result] = await db.query(`
            INSERT INTO personas (entidad_id, nuip, nombres, apellidos, nombre_completo, estado)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [entidadId, nuip, nombres, apellidos || null, nombreCompleto, estado]);

        return readMysqlPersonByNuip(nuip, { entidad_id: entidadId }) || {
            id: result.insertId,
            entidad_id: entidadId,
            nuip,
            nombres,
            apellidos: apellidos || null,
            nombre_completo: nombreCompleto,
            estado
        };
    } catch (error) {
        if (String(error.code || '') === 'ER_DUP_ENTRY') {
            error.statusCode = 409;
            error.message = 'Ya existe una persona con ese nuip para la entidad';
        } else if (String(error.code || '') === 'ER_NO_SUCH_TABLE') {
            error.statusCode = 500;
            error.message = 'La tabla personas no existe. Ejecuta la migracion 001_multi_entity_base.sql.';
        }

        throw error;
    }
}

async function updateMysqlPersonByNuip(currentNuip, payload = {}, options = {}) {
    const nuip = normalizeNuip(currentNuip);
    if (!nuip) {
        const error = new Error('nuip requerido');
        error.statusCode = 400;
        throw error;
    }

    const existingPerson = await readMysqlPersonByNuip(nuip, options);
    if (!existingPerson) {
        const error = new Error('Persona no encontrada');
        error.statusCode = 404;
        throw error;
    }

    const updates = [];
    const params = [];
    const nextNombres = payload.nombres !== undefined ? String(payload.nombres || '').trim() : existingPerson.nombres;
    const nextApellidos = payload.apellidos !== undefined ? String(payload.apellidos || '').trim() : String(existingPerson.apellidos || '').trim();

    if (payload.nombres !== undefined) {
        if (!nextNombres) {
            const error = new Error('nombres invalido');
            error.statusCode = 400;
            throw error;
        }
        updates.push('nombres = ?');
        params.push(nextNombres);
    }

    if (payload.apellidos !== undefined) {
        updates.push('apellidos = ?');
        params.push(nextApellidos || null);
    }

    if (payload.entidad_id !== undefined) {
        const entidadId = await resolveDefaultEntidadId(normalizePositiveIntegerId(payload.entidad_id));
        updates.push('entidad_id = ?');
        params.push(entidadId);
    }

    if (payload.estado !== undefined) {
        const estado = normalizePersonStatus(payload.estado);
        if (!estado) {
            const error = new Error('estado invalido');
            error.statusCode = 400;
            throw error;
        }
        updates.push('estado = ?');
        params.push(estado);
    }

    if (payload.nombre_completo !== undefined) {
        const nombreCompleto = String(payload.nombre_completo || '').trim();
        if (!nombreCompleto) {
            const error = new Error('nombre_completo invalido');
            error.statusCode = 400;
            throw error;
        }
        updates.push('nombre_completo = ?');
        params.push(nombreCompleto);
    } else if (payload.nombres !== undefined || payload.apellidos !== undefined) {
        updates.push('nombre_completo = ?');
        params.push(buildPersonFullName(nextNombres, nextApellidos));
    }

    if (updates.length === 0) {
        const error = new Error('Debes enviar al menos un campo actualizable');
        error.statusCode = 400;
        throw error;
    }

    try {
        params.push(existingPerson.id);
        await db.query(`UPDATE personas SET ${updates.join(', ')} WHERE id = ?`, params);
        return readMysqlPersonByNuip(nuip, { entidad_id: options.entidad_id || existingPerson.entidad_id });
    } catch (error) {
        if (String(error.code || '') === 'ER_NO_SUCH_TABLE') {
            error.statusCode = 500;
            error.message = 'La tabla personas no existe. Ejecuta la migracion 001_multi_entity_base.sql.';
        }

        throw error;
    }
}

async function deactivateMysqlPersonByNuip(nuip, options = {}) {
    const normalizedNuip = normalizeNuip(nuip);
    if (!normalizedNuip) {
        const error = new Error('nuip requerido');
        error.statusCode = 400;
        throw error;
    }

    const existingPerson = await readMysqlPersonByNuip(normalizedNuip, options);
    if (!existingPerson) {
        const error = new Error('Persona no encontrada');
        error.statusCode = 404;
        throw error;
    }

    await db.query('UPDATE personas SET estado = ? WHERE id = ?', ['inactivo', existingPerson.id]);
    return readMysqlPersonByNuip(normalizedNuip, { entidad_id: options.entidad_id || existingPerson.entidad_id });
}

async function readMysqlDeviceBySerial(targetDeviceSn) {
    const normalizedSn = normalizeRecordsScopeValue(targetDeviceSn);
    if (!normalizedSn) {
        return null;
    }

    const hasDispositivosTable = await mysqlTableExists('dispositivos');
    if (!hasDispositivosTable) {
        return null;
    }

    const [rows] = await db.query(`
        SELECT id, entidad_id, numero_serie, nombre, ip, estado, ultima_conexion, created_at, updated_at
        FROM dispositivos
        WHERE numero_serie = ?
        LIMIT 1
    `, [normalizedSn]);

    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function readMysqlDeviceById(deviceId) {
    const normalizedId = normalizePositiveIntegerId(deviceId);
    if (!normalizedId) {
        return null;
    }

    const hasDispositivosTable = await mysqlTableExists('dispositivos');
    if (!hasDispositivosTable) {
        return null;
    }

    const [rows] = await db.query(`
        SELECT id, entidad_id, numero_serie, nombre, ip, estado, ultima_conexion, created_at, updated_at
        FROM dispositivos
        WHERE id = ?
        LIMIT 1
    `, [normalizedId]);

    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function readMysqlPersonDeviceRelation(personId, deviceId) {
    const normalizedPersonId = normalizePositiveIntegerId(personId);
    const normalizedDeviceId = normalizePositiveIntegerId(deviceId);
    if (!normalizedPersonId || !normalizedDeviceId) {
        return null;
    }

    const [rows] = await db.query(`
        SELECT id, persona_id, dispositivo_id, pin_dispositivo, estado_sync,
               ultimo_comando_id AS ultimo_comando_id,
               created_at AS createdAt, updated_at AS updatedAt
        FROM persona_dispositivos
        WHERE persona_id = ? AND dispositivo_id = ?
        LIMIT 1
    `, [normalizedPersonId, normalizedDeviceId]);

    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function ensureMysqlPersonDeviceRelation({ personId, deviceId, pinDispositivo, lastCommandId = null, status = 'pending' }) {
    const normalizedPersonId = normalizePositiveIntegerId(personId);
    const normalizedDeviceId = normalizePositiveIntegerId(deviceId);
    const normalizedPinDispositivo = normalizePin(pinDispositivo);

    if (!normalizedPersonId || !normalizedDeviceId || !normalizedPinDispositivo) {
        const error = new Error('No se pudo resolver pin_dispositivo para el dispositivo');
        error.statusCode = 400;
        throw error;
    }

    const [conflicts] = await db.query(`
        SELECT pd.id, pd.persona_id, p.estado AS persona_estado, e.estado AS entidad_estado
        FROM persona_dispositivos pd
        INNER JOIN personas p ON p.id = pd.persona_id
        INNER JOIN entidades e ON e.id = p.entidad_id
        WHERE pd.dispositivo_id = ? AND pd.pin_dispositivo = ? AND pd.persona_id <> ?
        LIMIT 1
    `, [normalizedDeviceId, normalizedPinDispositivo, normalizedPersonId]);

    if (Array.isArray(conflicts) && conflicts[0]) {
        const conflict = conflicts[0];
        const personIsActive = String(conflict.persona_estado || '').trim().toLowerCase() === 'activo';
        const entityIsActive = String(conflict.entidad_estado || '').trim().toLowerCase() !== 'inactivo';
        if (personIsActive && entityIsActive) {
            const error = new Error('pin_dispositivo ya esta asignado a otra persona en ese dispositivo');
            error.statusCode = 409;
            error.code = 'NUIP_ALREADY_ASSIGNED_TO_DEVICE';
            throw error;
        }
    }

    const existingRelation = await readMysqlPersonDeviceRelation(normalizedPersonId, normalizedDeviceId);
    if (existingRelation) {
        await db.query(`
            UPDATE persona_dispositivos
            SET pin_dispositivo = ?, estado_sync = ?, ultimo_comando_id = ?
            WHERE id = ?
        `, [normalizedPinDispositivo, status, lastCommandId, existingRelation.id]);
    } else {
        await db.query(`
            INSERT INTO persona_dispositivos (persona_id, dispositivo_id, pin_dispositivo, estado_sync, ultimo_comando_id)
            VALUES (?, ?, ?, ?, ?)
        `, [normalizedPersonId, normalizedDeviceId, normalizedPinDispositivo, status, lastCommandId]);
    }

    return readMysqlPersonDeviceRelation(normalizedPersonId, normalizedDeviceId);
}

async function assertMysqlPersonDeviceAssignmentAllowed({ personId = null, entidadId, targetDeviceSn, pinDispositivo }) {
    const normalizedPersonId = normalizePositiveIntegerId(personId) || 0;
    const normalizedEntidadId = normalizePositiveIntegerId(entidadId);
    const normalizedTargetDeviceSn = normalizeRecordsScopeValue(targetDeviceSn);
    const normalizedPinDispositivo = normalizePin(pinDispositivo);

    if (!normalizedEntidadId || !normalizedTargetDeviceSn || !normalizedPinDispositivo) {
        const error = new Error('No se pudo validar la relacion persona-dispositivo');
        error.statusCode = 400;
        error.code = 'INVALID_REQUEST';
        throw error;
    }

    await assertMysqlEntityIsActive(normalizedEntidadId);

    const mysqlDevice = await readMysqlDeviceBySerial(normalizedTargetDeviceSn);
    if (!mysqlDevice) {
        const error = new Error('Dispositivo no encontrado para targetDeviceSn');
        error.statusCode = 404;
        error.code = 'DEVICE_NOT_FOUND';
        throw error;
    }

    if (normalizePositiveIntegerId(mysqlDevice.entidad_id) !== normalizedEntidadId) {
        const error = new Error('El dispositivo no pertenece a la entidad de esta API key');
        error.statusCode = 403;
        error.code = 'DEVICE_NOT_ALLOWED';
        throw error;
    }

    const [conflicts] = await db.query(`
        SELECT pd.id, pd.persona_id, p.estado AS persona_estado, e.estado AS entidad_estado
        FROM persona_dispositivos pd
        INNER JOIN personas p ON p.id = pd.persona_id
        INNER JOIN entidades e ON e.id = p.entidad_id
        WHERE pd.dispositivo_id = ?
          AND pd.pin_dispositivo = ?
          AND pd.persona_id <> ?
        LIMIT 1
    `, [mysqlDevice.id, normalizedPinDispositivo, normalizedPersonId]);

    if (Array.isArray(conflicts) && conflicts[0]) {
        const conflict = conflicts[0];
        const personIsActive = String(conflict.persona_estado || '').trim().toLowerCase() === 'activo';
        const entityIsActive = String(conflict.entidad_estado || '').trim().toLowerCase() !== 'inactivo';
        if (personIsActive && entityIsActive) {
            const error = new Error('Este NUIP ya está asignado a otra persona en el dispositivo indicado');
            error.statusCode = 409;
            error.code = 'NUIP_ALREADY_ASSIGNED_TO_DEVICE';
            throw error;
        }
    }

    return mysqlDevice;
}

async function deactivateMysqlPersonDeviceRelation(personId, deviceId) {
    const normalizedPersonId = normalizePositiveIntegerId(personId);
    const normalizedDeviceId = normalizePositiveIntegerId(deviceId);
    if (!normalizedPersonId || !normalizedDeviceId) {
        return null;
    }

    await db.query(`
        UPDATE persona_dispositivos
        SET estado_sync = ?
        WHERE persona_id = ? AND dispositivo_id = ?
    `, ['inactive', normalizedPersonId, normalizedDeviceId]);

    return readMysqlPersonDeviceRelation(normalizedPersonId, normalizedDeviceId);
}

async function updateMysqlPersonDeviceSyncStatusFromCommand(commandEntry, syncStatus) {
    const commandId = normalizeRecordsScopeValue(commandEntry?.commandId);
    const pinDispositivo = normalizePin(commandEntry?.pin);
    const targetDeviceSn = normalizeRecordsScopeValue(commandEntry?.targetDeviceSn);

    if (!commandId || !pinDispositivo || !targetDeviceSn) {
        return;
    }

    const mysqlDevice = await readMysqlDeviceBySerial(targetDeviceSn);
    const deviceId = normalizePositiveIntegerId(mysqlDevice?.id);
    if (!deviceId) {
        return;
    }

    await db.query(`
        UPDATE persona_dispositivos
        SET estado_sync = ?, ultimo_comando_id = ?
        WHERE dispositivo_id = ? AND pin_dispositivo = ?
    `, [syncStatus, commandId, deviceId, pinDispositivo]);
}

async function readEntityDeviceSerials(entidadId) {
    const normalizedEntidadId = normalizePositiveIntegerId(entidadId);
    if (!normalizedEntidadId) {
        return new Set();
    }

    const [rows] = await db.query(`
        SELECT numero_serie
        FROM dispositivos
        WHERE entidad_id = ?
    `, [normalizedEntidadId]);

    return new Set(
        (Array.isArray(rows) ? rows : [])
            .map(row => normalizeRecordsScopeValue(row.numero_serie))
            .filter(Boolean)
    );
}

async function readMysqlPersonsByNuip(nuip, options = {}) {
    return listMysqlPersons({
        nuip,
        entidad_id: options.entidad_id
    });
}

async function resolveEntityScopedMysqlPerson(nuip, options = {}) {
    const normalizedNuip = normalizeNuip(nuip);
    if (!normalizedNuip) {
        return null;
    }

    const entidadId = normalizePositiveIntegerId(options.entidad_id);
    const records = await readMysqlPersonsByNuip(normalizedNuip, { entidad_id: entidadId });

    if (entidadId) {
        return records[0] || null;
    }

    if (records.length <= 1) {
        return records[0] || null;
    }

    const error = new Error('Debes indicar entidad_id para este NUIP porque existe en varias entidades');
    error.statusCode = 409;
    error.code = 'ENTITY_SCOPE_REQUIRED';
    throw error;
}

function commandBelongsToEntity(command, entityDeviceSerials) {
    if (!(entityDeviceSerials instanceof Set) || entityDeviceSerials.size === 0) {
        return false;
    }

    return [
        normalizeRecordsScopeValue(command?.targetDeviceSn),
        normalizeRecordsScopeValue(command?.ackDeviceSn),
        normalizeRecordsScopeValue(command?.requestDeviceSn)
    ].some(sn => sn && entityDeviceSerials.has(sn));
}

function attendanceBelongsToEntity(attendance, entityDeviceSerials) {
    if (!(entityDeviceSerials instanceof Set) || entityDeviceSerials.size === 0) {
        return false;
    }

    const sn = normalizeRecordsScopeValue(attendance?.sn);
    return Boolean(sn && entityDeviceSerials.has(sn));
}

function generateClientApiKey() {
    return `client_${crypto.randomBytes(24).toString('hex')}`;
}

async function listAdminEntities() {
    const [rows] = await db.query(`
        SELECT
            e.id,
            e.nombre,
            e.codigo,
            e.estado,
            e.created_at,
            e.updated_at,
            (SELECT COUNT(*) FROM dispositivos d WHERE d.entidad_id = e.id) AS devicesCount,
            (SELECT COUNT(*) FROM entidad_api_credentials c WHERE c.entidad_id = e.id) AS apiClientsCount
        FROM entidades e
        ORDER BY e.id ASC
    `);

    return (Array.isArray(rows) ? rows : []).map(toPublicAdminEntity);
}

async function createAdminEntity(payload = {}) {
    const nombre = String(payload.nombre || payload.name || '').trim();
    const codigo = String(payload.codigo || payload.code || '').trim() || slugifyEntityCode(nombre);
    const enabled = normalizeAdminEnabled(
        payload.enabled !== undefined ? payload.enabled :
            (payload.status !== undefined ? payload.status : payload.estado),
        true
    );

    logStore.info('api.v1.admin.entities.create.normalized', {
        normalizedBody: { nombre, codigo, enabled }
    });

    if (!nombre) {
        const error = new Error('nombre es obligatorio');
        error.statusCode = 400;
        throw error;
    }

    if (!codigo) {
        const error = new Error('No fue posible generar un code valido para la entidad');
        error.statusCode = 400;
        throw error;
    }

    const columns = ['nombre', 'codigo', 'estado'];
    const values = [nombre, codigo, enabled ? 'activo' : 'inactivo'];

    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO entidades (${columns.join(', ')}) VALUES (${placeholders})`;
    try {
        logStore.info('api.v1.admin.entities.create.query', { sql, params: values });
        const [result] = await db.query(sql, values);
        const [rows] = await db.query('SELECT * FROM entidades WHERE id = ? LIMIT 1', [result.insertId]);
        return Array.isArray(rows) && rows[0] ? toPublicAdminEntity(rows[0]) : null;
    } catch (error) {
        logStore.error('api.v1.admin.entities.create.error', { sql, params: values, error: error.message });
        throw error;
    }
}

async function updateAdminEntity(entityId, payload = {}) {
    const normalizedId = normalizePositiveIntegerId(entityId);
    if (!normalizedId) {
        const error = new Error('entityId invalido');
        error.statusCode = 400;
        throw error;
    }

    const updates = [];
    const params = [];
    const enabled = normalizeAdminEnabled(
        payload.enabled !== undefined ? payload.enabled :
            (payload.status !== undefined ? payload.status : payload.estado)
    );

    if (payload.nombre !== undefined || payload.name !== undefined) {
        updates.push('nombre = ?');
        params.push(String(payload.nombre || payload.name || '').trim());
    }

    if (payload.codigo !== undefined || payload.code !== undefined) {
        updates.push('codigo = ?');
        params.push(String(payload.codigo || payload.code || '').trim());
    }

    if (enabled !== null) {
        updates.push('estado = ?');
        params.push(enabled ? 'activo' : 'inactivo');
    }

    if (updates.length === 0) {
        const error = new Error('Debes enviar al menos un campo actualizable');
        error.statusCode = 400;
        throw error;
    }

    params.push(normalizedId);
    await db.query(`UPDATE entidades SET ${updates.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query('SELECT * FROM entidades WHERE id = ? LIMIT 1', [normalizedId]);
    return Array.isArray(rows) && rows[0] ? toPublicAdminEntity(rows[0]) : null;
}

async function listAdminDevices(filters = {}) {
    const entidadId = normalizePositiveIntegerId(filters.entidad_id);
    const clauses = [];
    const params = [];

    if (entidadId) {
        clauses.push('d.entidad_id = ?');
        params.push(entidadId);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await db.query(`
        SELECT d.*, e.nombre AS entidad_nombre
        FROM dispositivos d
        LEFT JOIN entidades e ON e.id = d.entidad_id
        ${whereClause}
        ORDER BY d.id ASC
    `, params);

    return (Array.isArray(rows) ? rows : []).map(toPublicAdminDevice);
}

async function createAdminDevice(payload = {}) {
    const entidadId = normalizePositiveIntegerId(payload.entidad_id || payload.entityId);
    const numeroSerie = String(payload.numero_serie || payload.serial || payload.sn || '').trim();
    const nombre = String(payload.nombre || payload.name || '').trim();
    const ip = String(payload.ip || '').trim() || null;
    const enabled = normalizeAdminEnabled(
        payload.enabled !== undefined ? payload.enabled :
            (payload.status !== undefined ? payload.status : payload.estado),
        true
    );
    const estado = enabled ? 'activo' : 'inactivo';

    logStore.info('api.v1.admin.devices.create.normalized', {
        normalizedBody: { entidadId, numeroSerie, nombre, ip, enabled }
    });

    if (!entidadId || !numeroSerie || !nombre) {
        const error = new Error('entidad_id, numero_serie y nombre son obligatorios');
        error.statusCode = 400;
        throw error;
    }

    await assertMysqlEntityIsActive(entidadId);

    const columns = ['entidad_id', 'numero_serie', 'nombre', 'ip'];
    const values = [entidadId, numeroSerie, nombre, ip];

    columns.push('estado');
    values.push(estado);

    const sql = `INSERT INTO dispositivos (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    try {
        logStore.info('api.v1.admin.devices.create.query', { sql, params: values });
        const [result] = await db.query(sql, values);
        const [rows] = await db.query(`
            SELECT d.*, e.nombre AS entidad_nombre
            FROM dispositivos d
            LEFT JOIN entidades e ON e.id = d.entidad_id
            WHERE d.id = ?
            LIMIT 1
        `, [result.insertId]);
        return Array.isArray(rows) && rows[0] ? toPublicAdminDevice(rows[0]) : null;
    } catch (error) {
        logStore.error('api.v1.admin.devices.create.error', { sql, params: values, error: error.message });
        if (error && error.code === 'ER_DUP_ENTRY' && String(error.message || '').includes('numero_serie')) {
            const duplicateError = new Error('Dispositivo con este numero_serie ya existe');
            duplicateError.statusCode = 409;
            duplicateError.code = 'DUPLICATE_DEVICE';
            throw duplicateError;
        }
        throw error;
    }
}

async function updateAdminDevice(deviceId, payload = {}) {
    const normalizedId = normalizePositiveIntegerId(deviceId);
    const serialIdentifier = normalizedId ? null : String(deviceId || '').trim();
    const updates = [];
    const params = [];
    const enabled = normalizeAdminEnabled(
        payload.enabled !== undefined ? payload.enabled :
            (payload.status !== undefined ? payload.status : payload.estado)
    );

    if (!normalizedId && !serialIdentifier) {
        const error = new Error('deviceId invalido');
        error.statusCode = 400;
        throw error;
    }

    const currentDevice = normalizedId
        ? await readMysqlDeviceById(normalizedId)
        : await readMysqlDeviceBySerial(serialIdentifier);
    if (!currentDevice) {
        const error = new Error('Dispositivo no encontrado');
        error.statusCode = 404;
        error.code = 'DEVICE_NOT_FOUND';
        throw error;
    }

    const entidadId = payload.entidad_id !== undefined
        ? normalizePositiveIntegerId(payload.entidad_id)
        : normalizePositiveIntegerId(payload.entityId);
    if (entidadId !== null) {
        await assertMysqlEntityIsActive(entidadId);
        updates.push('entidad_id = ?');
        params.push(entidadId);
    }

    if (enabled === true) {
        await assertMysqlEntityIsActive(entidadId || currentDevice.entidad_id);
    }

    if (payload.numero_serie !== undefined || payload.serial !== undefined || payload.sn !== undefined) {
        updates.push('numero_serie = ?');
        params.push(String(payload.numero_serie || payload.serial || payload.sn || '').trim());
    }

    if (payload.nombre !== undefined || payload.name !== undefined) {
        updates.push('nombre = ?');
        params.push(String(payload.nombre || payload.name || '').trim());
    }

    if (payload.ip !== undefined) {
        updates.push('ip = ?');
        params.push(String(payload.ip || '').trim() || null);
    }

    if (enabled !== null) {
        updates.push('estado = ?');
        params.push(enabled ? 'activo' : 'inactivo');
    }

    if (updates.length === 0) {
        const error = new Error('Debes enviar al menos un campo actualizable');
        error.statusCode = 400;
        throw error;
    }

    let sql;
    if (normalizedId) {
        params.push(normalizedId);
        sql = `UPDATE dispositivos SET ${updates.join(', ')} WHERE id = ?`;
    } else {
        params.push(serialIdentifier);
        sql = `UPDATE dispositivos SET ${updates.join(', ')} WHERE numero_serie = ?`;
    }

    logStore.info('api.v1.admin.devices.update.normalized', {
        normalizedBody: payload,
        lookup: normalizedId ? { id: normalizedId } : { numero_serie: serialIdentifier },
        sql,
        params
    });

    await db.query(sql, params);

    const [rows] = normalizedId
        ? await db.query(`
            SELECT d.*, e.nombre AS entidad_nombre
            FROM dispositivos d
            LEFT JOIN entidades e ON e.id = d.entidad_id
            WHERE d.id = ?
            LIMIT 1
        `, [normalizedId])
        : await db.query(`
            SELECT d.*, e.nombre AS entidad_nombre
            FROM dispositivos d
            LEFT JOIN entidades e ON e.id = d.entidad_id
            WHERE d.numero_serie = ?
            LIMIT 1
        `, [serialIdentifier]);

    return Array.isArray(rows) && rows[0] ? toPublicAdminDevice(rows[0]) : null;
}

async function listAdminApiClients(filters = {}) {
    const entidadId = normalizePositiveIntegerId(filters.entidad_id);
    const clauses = [];
    const params = [];

    if (entidadId) {
        clauses.push('c.entidad_id = ?');
        params.push(entidadId);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [rows] = await db.query(`
        SELECT c.id, c.entidad_id, c.nombre, c.key_prefix, c.enabled, c.last_used_at AS lastUsedAt,
               c.created_at AS createdAt, c.updated_at AS updatedAt,
               e.nombre AS entidad_nombre, e.codigo AS entidad_codigo
        FROM entidad_api_credentials c
        LEFT JOIN entidades e ON e.id = c.entidad_id
        ${whereClause}
        ORDER BY c.id ASC
    `, params);

    return Array.isArray(rows) ? rows : [];
}

async function createAdminApiClient(payload = {}) {
    const entidadId = normalizePositiveIntegerId(payload.entidad_id || payload.entityId);
    const nombre = String(payload.nombre || payload.name || '').trim();
    const enabled = normalizeAdminEnabled(
        payload.enabled !== undefined ? payload.enabled :
            (payload.status !== undefined ? payload.status : payload.estado),
        true
    );

    logStore.info('api.v1.admin.api-clients.create.normalized', {
        normalizedBody: { entidadId, nombre, enabled }
    });

    if (!entidadId || !nombre) {
        const error = new Error('entidad_id y nombre son obligatorios');
        error.statusCode = 400;
        throw error;
    }

    await assertMysqlEntityIsActive(entidadId);

    let apiKey = '';
    let keyPrefix = '';
    let alreadyExists = true;

    while (alreadyExists) {
        apiKey = generateClientApiKey();
        keyPrefix = buildApiKeyPrefix(apiKey);
        const [rows] = await db.query('SELECT id FROM entidad_api_credentials WHERE key_prefix = ? LIMIT 1', [keyPrefix]);
        alreadyExists = Array.isArray(rows) && rows.length > 0;
    }

    const keyHash = hashApiKey(apiKey);
    const sql = `INSERT INTO entidad_api_credentials (entidad_id, nombre, key_prefix, key_hash, enabled) VALUES (?, ?, ?, ?, ?)`;
    const params = [entidadId, nombre, keyPrefix, keyHash, enabled ? 1 : 0];
    try {
        logStore.info('api.v1.admin.api-clients.create.query', { sql, params });
        const [result] = await db.query(sql, params);
        const [rows] = await db.query(`
            SELECT id, entidad_id, nombre, key_prefix, enabled, last_used_at AS lastUsedAt,
                   created_at AS createdAt, updated_at AS updatedAt
            FROM entidad_api_credentials
            WHERE id = ?
            LIMIT 1
        `, [result.insertId]);

        return {
            client: Array.isArray(rows) && rows[0] ? rows[0] : null,
            apiKey
        };
    } catch (error) {
        logStore.error('api.v1.admin.api-clients.create.error', { sql, params, error: error.message });
        throw error;
    }
}

async function updateAdminApiClient(clientId, payload = {}) {
    const normalizedId = normalizePositiveIntegerId(clientId);
    const enabled = normalizeAdminEnabled(
        payload.enabled !== undefined ? payload.enabled :
            (payload.status !== undefined ? payload.status : payload.estado)
    );
    const updates = [];
    const params = [];

    if (!normalizedId) {
        const error = new Error('clientId invalido');
        error.statusCode = 400;
        throw error;
    }

    if (payload.nombre !== undefined || payload.name !== undefined) {
        updates.push('nombre = ?');
        params.push(String(payload.nombre || payload.name || '').trim());
    }

    if (enabled !== null) {
        updates.push('enabled = ?');
        params.push(enabled ? 1 : 0);
    }

    if (updates.length === 0) {
        const error = new Error('Debes enviar al menos un campo actualizable');
        error.statusCode = 400;
        throw error;
    }

    params.push(normalizedId);
    await db.query(`UPDATE entidad_api_credentials SET ${updates.join(', ')} WHERE id = ?`, params);
    const [rows] = await db.query(`
        SELECT id, entidad_id, nombre, key_prefix, enabled, last_used_at AS lastUsedAt,
               created_at AS createdAt, updated_at AS updatedAt
        FROM entidad_api_credentials
        WHERE id = ?
        LIMIT 1
    `, [normalizedId]);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function softDeleteAdminEntity(entityId) {
    const normalizedId = normalizePositiveIntegerId(entityId);
    if (!normalizedId) {
        const error = new Error('entityId invalido');
        error.statusCode = 400;
        throw error;
    }

    await db.query('UPDATE entidades SET estado = ? WHERE id = ?', ['inactivo', normalizedId]);
    const [rows] = await db.query('SELECT * FROM entidades WHERE id = ? LIMIT 1', [normalizedId]);
    return Array.isArray(rows) && rows[0] ? toPublicAdminEntity(rows[0]) : null;
}

async function softDeleteAdminDevice(deviceSerial) {
    const serial = String(deviceSerial || '').trim();
    if (!serial) {
        const error = new Error('deviceSerial invalido');
        error.statusCode = 400;
        throw error;
    }

    await db.query('UPDATE dispositivos SET estado = ? WHERE numero_serie = ?', ['inactivo', serial]);
    const [rows] = await db.query(`
        SELECT d.*, e.nombre AS entidad_nombre
        FROM dispositivos d
        LEFT JOIN entidades e ON e.id = d.entidad_id
        WHERE d.numero_serie = ?
        LIMIT 1
    `, [serial]);
    return Array.isArray(rows) && rows[0] ? toPublicAdminDevice(rows[0]) : null;
}

async function softDeleteAdminApiClient(clientId) {
    const normalizedId = normalizePositiveIntegerId(clientId);
    if (!normalizedId) {
        const error = new Error('clientId invalido');
        error.statusCode = 400;
        throw error;
    }

    await db.query('UPDATE entidad_api_credentials SET enabled = ? WHERE id = ?', [0, normalizedId]);
    const [rows] = await db.query(`
        SELECT id, entidad_id, nombre, key_prefix, enabled, last_used_at AS lastUsedAt,
               created_at AS createdAt, updated_at AS updatedAt
        FROM entidad_api_credentials
        WHERE id = ?
        LIMIT 1
    `, [normalizedId]);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function isDeletedPersonStatus(status) {
    return String(status || '').trim().toLowerCase() === 'eliminado';
}

function buildCommandAcceptedInstant(command) {
    const candidate = command?.acknowledgedAt || command?.sentAt || command?.createdAt || command?.timestamp || null;
    const timestamp = candidate ? Date.parse(candidate) : NaN;
    return Number.isFinite(timestamp) ? timestamp : null;
}

function parseUserinfoCommandFields(commandText) {
    const text = String(commandText || '');
    return {
        pin: normalizePin((text.match(/\bPIN=(\d+)\b/i) || [])[1] || ''),
        name: ((text.match(/(?:^|\t)Name=([^\t]*)/) || [])[1] || '').trim(),
        password: ((text.match(/(?:^|\t)Passwd=([^\t]*)/) || [])[1] || '').trim()
    };
}

function resolveLatestKnownUserinfoProfile(pin, filters = {}) {
    const normalizedPin = normalizePin(pin);
    if (!normalizedPin) {
        return null;
    }

    const queueEntries = readAdmsCommandQueue()
        .filter(entry => String(entry.pin || '') === normalizedPin)
        .filter(entry => String(entry.commandType || '').toUpperCase() === 'USERINFO')
        .filter(entry => matchesScopedRecord(entry, filters, {
            snFields: ['targetDeviceSn', 'ackDeviceSn', 'requestDeviceSn'],
            siteIdFields: ['siteId']
        }))
        .slice()
        .sort((left, right) => String(right.acknowledgedAt || right.sentAt || right.createdAt || '').localeCompare(String(left.acknowledgedAt || left.sentAt || left.createdAt || '')));

    for (const entry of queueEntries) {
        const parsed = parseUserinfoCommandFields(entry.command);
        if (parsed.pin === normalizedPin && parsed.name) {
            return {
                ...parsed,
                status: String(entry.status || 'queued'),
                commandId: String(entry.commandId || '')
            };
        }
    }

    return null;
}

function resolveDeviceProfileCommandStatuses(commandRefs = []) {
    const queueEntries = readAdmsCommandQueue();
    return commandRefs
        .filter(Boolean)
        .map(({ commandId, commandType }) => {
            const entry = queueEntries.find(item => String(item.commandId || '') === String(commandId || ''));
            const rawStatus = String(entry?.status || 'queued');
            const status = rawStatus === 'accepted'
                ? 'accepted'
                : rawStatus === 'failed'
                    ? 'failed'
                    : 'pending';

            return {
                commandId: String(commandId || ''),
                commandType: String(commandType || ''),
                status,
                acceptedByDevice: status === 'accepted',
                targetDeviceSn: entry?.targetDeviceSn || null,
                siteId: entry?.siteId || null
            };
        });
}

async function buildApiPersonExistence(pin, siteId, targetDeviceSn) {
    const normalizedPin = normalizePin(pin);
    const normalizedSiteId = normalizeRecordsScopeValue(siteId);
    const normalizedTargetDeviceSn = normalizeRecordsScopeValue(targetDeviceSn);
    const localPerson = readLatestAdmsPersonByPin(normalizedPin);
    const dbPerson = await readDbPersonByPin(normalizedPin);
    const commandFilters = normalizedTargetDeviceSn || normalizedSiteId
        ? { scopeAll: false, siteId: normalizedSiteId, activeSn: normalizedTargetDeviceSn }
        : { scopeAll: true, siteId: '', activeSn: '' };
    const effectivePersons = await buildPersonsReadModel(commandFilters, { pin: normalizedPin });
    const effectiveScopedPerson = Array.isArray(effectivePersons?.records) ? (effectivePersons.records[0] || null) : null;
    const scopedCommands = buildAdmsCommandsReadModel(commandFilters, { pin: normalizedPin });
    const acceptedTimeline = scopedCommands
        .filter(command => String(command.status || '') === 'accepted')
        .map(command => ({
            ...command,
            acceptedAt: buildCommandAcceptedInstant(command)
        }))
        .filter(command => Number.isFinite(command.acceptedAt))
        .sort((left, right) => right.acceptedAt - left.acceptedAt);
    const latestAcceptedUpsert = acceptedTimeline.find(command =>
        ['USERINFO', 'BIOPHOTO'].includes(String(command.commandType || '').toUpperCase())
    ) || null;
    const latestAcceptedDelete = acceptedTimeline.find(command =>
        String(command.commandType || '').toUpperCase() === 'DELETE_USERINFO'
    ) || null;
    const currentPersonSource = effectiveScopedPerson || localPerson || dbPerson || null;
    const currentStatus = effectiveScopedPerson?.status || localPerson?.status || dbPerson?.status || null;
    const effectiveScopedIsDeleted = Boolean(effectiveScopedPerson && isDeletedPersonStatus(effectiveScopedPerson.status));
    const latestLocalIsDeleted = Boolean(localPerson && isDeletedPersonStatus(localPerson.status));
    const existsHistorical = Boolean(effectiveScopedPerson || localPerson || dbPerson || scopedCommands.length > 0);
    const existsLocalActive = effectiveScopedIsDeleted
        ? false
        : latestLocalIsDeleted
        ? false
        : Boolean(
            (effectiveScopedPerson && !isDeletedPersonStatus(effectiveScopedPerson.status)) ||
            (!effectiveScopedPerson && localPerson && !isDeletedPersonStatus(localPerson.status)) ||
            (!effectiveScopedPerson && !localPerson && dbPerson && !isDeletedPersonStatus(dbPerson.status))
        );
    const existsLocal = existsLocalActive;

    let existsInDevice = false;
    let confidence = 'unknown';

    if (latestAcceptedUpsert) {
        existsInDevice = !latestAcceptedDelete || latestAcceptedDelete.acceptedAt < latestAcceptedUpsert.acceptedAt;
        confidence = 'high';
    } else if (!effectiveScopedIsDeleted && !latestLocalIsDeleted && localPerson && localPerson.deviceSyncStatus === 'accepted_by_device') {
        existsInDevice = true;
        confidence = 'high';
    } else if (latestAcceptedDelete || scopedCommands.length > 0) {
        existsInDevice = false;
        confidence = 'high';
    }

    return {
        pin: normalizedPin,
        siteId: normalizedSiteId || null,
        targetDeviceSn: normalizedTargetDeviceSn || null,
        existsHistorical,
        existsLocal,
        existsLocalActive,
        existsInDevice,
        canCreate: !existsLocalActive && !existsInDevice,
        confidence,
        currentPerson: {
            pin: normalizedPin,
            name: currentPersonSource?.name || null,
            status: currentStatus || 'desconocido',
            deviceSyncStatus: effectiveScopedPerson?.deviceSyncStatus || localPerson?.deviceSyncStatus || 'unknown',
            userCommandId: effectiveScopedPerson?.userCommandId || localPerson?.userCommandId || null,
            biophotoCommandId: effectiveScopedPerson?.biophotoCommandId || localPerson?.biophotoCommandId || null
        }
    };
}

function readAdmsDevices() {
    const devices = readJsonLinesFile(admsDevicesLogPath);
    const sites = readAdmsSites();
    const now = new Date();

    if (devices.length === 0) {
        const defaultDevice = buildDeviceRecord(DEFAULT_TARGET_DEVICE_SN, {}, sites);
        return [{
            ...defaultDevice,
            numero_serie: defaultDevice.sn,
            segundos_desde_ultima_conexion: null,
            minutos_desde_ultima_conexion: null,
            estado: 'offline'
        }];
    }

    return devices.map(device => {
        const mergedDevice = buildDeviceRecord(device.sn, device, sites);
        const ultimaConexion = mergedDevice.ultima_conexion ? new Date(mergedDevice.ultima_conexion) : null;
        const hasConnection = ultimaConexion instanceof Date && !Number.isNaN(ultimaConexion.getTime());
        const segundosDesde = hasConnection ? Math.floor((now - ultimaConexion) / 1000) : null;
        const minutosDesde = Number.isInteger(segundosDesde) ? Math.floor(segundosDesde / 60) : null;

        let estado;
        if (!Number.isInteger(segundosDesde)) {
            estado = 'offline';
        } else if (segundosDesde <= 60) {
            estado = 'online';
        } else if (segundosDesde <= 180) {
            estado = 'sin_comunicacion_reciente';
        } else {
            estado = 'offline';
        }

        return {
            ...mergedDevice,
            numero_serie: mergedDevice.sn,
            segundos_desde_ultima_conexion: segundosDesde,
            minutos_desde_ultima_conexion: minutosDesde,
            estado,
            lastSeenAt: mergedDevice.ultima_conexion || null
        };
    });
}

function toBooleanFlag(value) {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return value > 0;
    }

    const text = String(value || '').trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes';
}

// API authentication functions moved to src/middleware/apiKeyAuth.js
// - safeEqualsApiKey
// - extractApiV1KeyFromRequest
// - requireApiV1Key

function resolvePersonPhotoInfo(pin, photoDbValue) {
    const normalizedPin = normalizePin(pin);
    const rawPhotoValue = String(photoDbValue || '').trim();
    const candidatePaths = [];

    const pushCandidate = candidate => {
        const next = path.normalize(candidate);
        if (!candidatePaths.includes(next)) {
            candidatePaths.push(next);
        }
    };

    if (rawPhotoValue) {
        if (/^uploads[\\/]/i.test(rawPhotoValue)) {
            pushCandidate(path.join(__dirname, rawPhotoValue.replace(/^uploads[\\/]/i, 'uploads\\')));
        } else {
            pushCandidate(path.join(uploadsDir, rawPhotoValue));
            pushCandidate(path.join(facesUploadsDir, rawPhotoValue));
        }
    }

    if (normalizedPin) {
        pushCandidate(path.join(facesUploadsDir, `${normalizedPin}.jpg`));
    }

    const matchingBiophotos = [];
    if (normalizedPin && fs.existsSync(biophotosDir)) {
        for (const fileName of fs.readdirSync(biophotosDir)) {
            if (new RegExp(`^${normalizedPin}-.*\\.jpg$`, 'i').test(fileName)) {
                const fullPath = path.join(biophotosDir, fileName);
                pushCandidate(fullPath);
                matchingBiophotos.push(fullPath);
            }
        }
    }

    const resolvedPath = candidatePaths.find(candidate => fs.existsSync(candidate)) || null;
    return {
        fotoRegistradaEnBd: Boolean(rawPhotoValue),
        photoDbValue: rawPhotoValue || null,
        fotoDbValue: rawPhotoValue || null,
        photoResolvedPath: resolvedPath,
        fotoResolvedPath: resolvedPath,
        photoFileExists: Boolean(resolvedPath),
        fotoExisteFisicamente: Boolean(resolvedPath),
        hasPhoto: Boolean(resolvedPath),
        matchingBiophotos
    };
}

function updateAdmsDevice(sn, ip, originalUrl, method, userAgent, options = {}) {
    const normalizedSn = String(sn || '').trim();
    if (!normalizedSn) {
        return;
    }

    void updateMysqlAdmsDeviceState({
        sn: normalizedSn,
        ip,
        originalUrl,
        method,
        userAgent,
        options
    }).catch(error => {
        logStore.error('adms.device.mysql-update.error', {
            sn: normalizedSn,
            ip,
            originalUrl,
            method,
            userAgent,
            error: error.message
        });
    });

    try {
        updateAdmsDeviceAuditFile(normalizedSn, ip, originalUrl, method, userAgent, options);
    } catch (error) {
        logStore.warn('adms.device.audit-file.skipped', {
            sn: normalizedSn,
            error: error.message
        });
    }
}

async function updateMysqlAdmsDeviceState({ sn, ip, originalUrl, method, userAgent, options = {} }) {
    const hasDispositivosTable = await mysqlTableExists('dispositivos');
    if (!hasDispositivosTable) {
        logStore.warn('adms.device.mysql-table-missing', {
            sn,
            table: 'dispositivos'
        });
        return;
    }

    const [result] = await db.query(
        `UPDATE dispositivos
         SET ip = ?, ultima_conexion = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE numero_serie = ?`,
        [String(ip || '').trim() || null, sn]
    );

    if (!result || result.affectedRows === 0) {
        logStore.warn('adms.device.unregistered', {
            sn,
            ip,
            originalUrl,
            method,
            userAgent,
            userCount: options.userCount || null,
            faceCount: options.faceCount || null,
            multiBioDataCount: options.multiBioDataCount || null,
            multiBioPhotoCount: options.multiBioPhotoCount || null
        });
        return;
    }

    logStore.info('adms.device.mysql-updated', {
        sn,
        ip,
        affectedRows: result.affectedRows
    });
}

function updateAdmsDeviceAuditFile(sn, ip, originalUrl, method, userAgent, options = {}) {
    const devices = readJsonLinesFile(admsDevicesLogPath);
    const now = new Date().toISOString();
    const existingIndex = devices.findIndex(d => d.sn === sn);
    const defaultConfig = getDeviceConfigBySn(sn);

    const deviceData = {
        ...defaultConfig,
        sn: String(sn || '').trim() || defaultConfig.sn,
        ip,
        ultima_conexion: now,
        lastSeenAt: now,
        lastOriginalUrl: originalUrl,
        lastMethod: method,
        lastUserAgent: userAgent,
        ...options
    };

    if (existingIndex >= 0) {
        devices[existingIndex] = { ...devices[existingIndex], ...deviceData };
    } else {
        devices.push(deviceData);
    }

    writeJsonLinesFile(admsDevicesLogPath, devices);
}

function updateAdmsDeviceConfig(sn, updates = {}) {
    const normalizedSn = String(sn || '').trim();
    if (!normalizedSn) {
        throw new Error('SN invalido');
    }

    const sites = readAdmsSites();
    const devices = readJsonLinesFile(admsDevicesLogPath);
    const existingIndex = devices.findIndex(entry => String(entry.sn || '').trim() === normalizedSn);
    const existingEntry = existingIndex >= 0 ? devices[existingIndex] : {};
    const nextSiteId = updates.siteId !== undefined
        ? String(updates.siteId || '').trim()
        : String(existingEntry.siteId || getDeviceConfigBySn(normalizedSn).siteId || DEFAULT_SITE_ID).trim();
    const site = findAdmsSiteById(nextSiteId, sites);

    if (!site) {
        throw new Error(`La sede ${nextSiteId || '(vacia)'} no existe`);
    }

    const shouldEnable = updates.enabled === undefined
        ? (existingEntry.enabled !== false)
        : Boolean(updates.enabled);
    const isAllowedInSite = Array.isArray(site.allowedDeviceSns) && site.allowedDeviceSns.includes(normalizedSn);

    if (shouldEnable && !isAllowedInSite) {
        throw new Error(`El SN ${normalizedSn} no esta permitido en la sede ${site.siteId}`);
    }

    const nextEntry = {
        ...existingEntry,
        sn: normalizedSn,
        siteId: nextSiteId,
        name: updates.name !== undefined ? String(updates.name || '').trim() : existingEntry.name,
        deviceName: updates.deviceName !== undefined ? String(updates.deviceName || '').trim() : existingEntry.deviceName,
        locationName: updates.locationName !== undefined ? String(updates.locationName || '').trim() : existingEntry.locationName,
        enabled: shouldEnable
    };

    if (existingIndex >= 0) {
        devices[existingIndex] = nextEntry;
    } else {
        devices.push(nextEntry);
    }

    writeJsonLinesFile(admsDevicesLogPath, devices);
    return getDeviceConfigBySn(normalizedSn);
}

function getAdmsDeviceBySn(sn) {
    const normalizedSn = String(sn || '').trim();
    if (!normalizedSn) {
        return null;
    }

    return readAdmsDevices().find(device => String(device.sn || '').trim() === normalizedSn) || null;
}

function buildApiDevicesReadModel({ siteId = '', scopeAll = false } = {}) {
    const normalizedSiteId = String(siteId || '').trim();
    const devices = readAdmsDevices().map(device => ({
        sn: device.sn,
        name: device.name || device.deviceName || '',
        deviceName: device.deviceName || device.name || '',
        siteId: device.siteId || null,
        locationName: device.locationName || null,
        hostname: device.hostname || null,
        ip: device.ip || null,
        enabled: device.enabled !== false,
        discoveredOnly: Boolean(device.discoveredOnly),
        estado: device.estado || 'offline',
        ultima_conexion: device.ultima_conexion || null,
        lastSeenAt: device.lastSeenAt || null,
        userCount: device.userCount || null,
        faceCount: device.faceCount || null,
        multiBioDataCount: device.multiBioDataCount || null,
        multiBioPhotoCount: device.multiBioPhotoCount || null
    }));

    if (scopeAll || !normalizedSiteId) {
        return devices;
    }

    const site = findAdmsSiteById(normalizedSiteId);
    const allowedSnSet = new Set(Array.isArray(site?.allowedDeviceSns) ? site.allowedDeviceSns.map(value => String(value || '').trim()).filter(Boolean) : []);
    return devices.filter(device => String(device.siteId || '').trim() === normalizedSiteId || allowedSnSet.has(String(device.sn || '').trim()));
}

function upsertAdmsSiteRecord(siteId, payload = {}, options = {}) {
    const normalizedSiteId = String(siteId || '').trim();
    const requireExisting = options.requireExisting === true;

    if (!normalizedSiteId || !/^[a-zA-Z0-9_-]{1,50}$/.test(normalizedSiteId)) {
        const error = new Error('siteId invalido');
        error.statusCode = 400;
        throw error;
    }

    const sites = readAdmsSites();
    const siteIndex = sites.findIndex(site => String(site.siteId || '').trim() === normalizedSiteId);
    const currentSite = siteIndex >= 0 ? sites[siteIndex] : null;

    if (requireExisting && !currentSite) {
        const error = new Error(`La sede ${normalizedSiteId} no existe`);
        error.statusCode = 404;
        throw error;
    }

    const name = payload.name !== undefined ? String(payload.name || '').trim() : String(currentSite?.name || '').trim();
    const hostname = payload.hostname !== undefined
        ? (payload.hostname == null || payload.hostname === '' ? null : normalizeRequestHostname(payload.hostname))
        : (currentSite?.hostname ?? null);
    const enabled = payload.enabled !== undefined ? payload.enabled !== false : (currentSite ? currentSite.enabled !== false : true);

    if (!name) {
        const error = new Error('name es obligatorio');
        error.statusCode = 400;
        throw error;
    }

    const nextSite = {
        siteId: normalizedSiteId,
        name,
        hostname,
        enabled,
        allowedDeviceSns: Array.isArray(currentSite?.allowedDeviceSns) ? currentSite.allowedDeviceSns : []
    };

    if (siteIndex >= 0) {
        sites[siteIndex] = { ...currentSite, ...nextSite };
    } else {
        sites.push(nextSite);
    }

    const updatedSites = writeAdmsSites(sites);
    return {
        created: siteIndex < 0,
        site: updatedSites.find(site => String(site.siteId || '').trim() === normalizedSiteId) || nextSite
    };
}

async function buildPersonsReadModel(filters, options = {}) {
    const scopedPersonPins = buildScopedPersonPins(filters);
    const pinFilter = normalizePin(options.pin);
    const statusFilter = String(options.status || '').trim().toLowerCase();

    const applyPersonScope = persons => {
        if (filters.scopeAll) {
            return { records: persons, legacyUnassignedCount: 0, message: '' };
        }

        const records = persons.filter(person => scopedPersonPins.has(String(person.pin || '')));
        const legacyUnassignedCount = Math.max(0, persons.length - records.length);
        return {
            records,
            legacyUnassignedCount,
            message: legacyUnassignedCount > 0
                ? 'Personas legacy sin dispositivo asignado. Use Ver todos para revisarlas.'
                : ''
        };
    };

    const applyAdditionalFilters = payload => {
        const records = payload.records.filter(person => {
            if (pinFilter && String(person.pin || '') !== pinFilter) {
                return false;
            }

            if (statusFilter && String(person.status || '').trim().toLowerCase() !== statusFilter) {
                return false;
            }

            return true;
        });

        return {
            ...payload,
            records
        };
    };

    try {
        const [mysqlPersons] = await db.query(`
            SELECT pin, nombre as name, foto as photo,
                   LENGTH(template) > 0 as hasBiodata,
                   estado as status,
                   created_at as createdAt,
                   updated_at as updatedAt
            FROM usuarios
        `);

        const admsPersons = readLatestAdmsPersons();
        const attendanceEntries = readAttendanceEntries();
        const attendanceByPin = new Set(attendanceEntries.map(entry => String(entry.pin)));

        const enrichedPersons = mysqlPersons.map(person => {
            const admsData = admsPersons.find(adms => adms.pin === person.pin);
            const photoInfo = resolvePersonPhotoInfo(person.pin, person.photo || admsData?.photo || '');
            const deviceSyncStatus = admsData?.deviceSyncStatus || computeDeviceSyncStatusForPin(person.pin);
            const hasAttendance = attendanceByPin.has(String(person.pin));
            return {
                nuip: admsData?.nuip || null,
                pin: person.pin,
                name: person.name,
                photo: person.photo,
                photoDbValue: photoInfo.photoDbValue,
                photoFileExists: photoInfo.photoFileExists,
                photoResolvedPath: photoInfo.photoResolvedPath,
                imageSize: admsData?.imageSize || null,
                userCommandId: admsData?.userCommandId || null,
                biophotoCommandId: admsData?.biophotoCommandId || null,
                biodataCommandId: admsData?.biodataCommandId || null,
                hasAttendance,
                attendanceConfirmed: hasAttendance,
                hasPhoto: photoInfo.hasPhoto,
                hasBiodata: toBooleanFlag(person.hasBiodata),
                status: person.status,
                deviceSyncStatus,
                siteId: admsData?.siteId || null,
                targetDeviceSn: admsData?.targetDeviceSn || null,
                createdAt: person.createdAt,
                updatedAt: person.updatedAt
            };
        });

        return {
            ...applyAdditionalFilters(applyPersonScope(enrichedPersons)),
            source: 'mysql'
        };
    } catch (_error) {
        const admsPersons = readLatestAdmsPersons();
        const attendanceEntries = readAttendanceEntries();
        const attendanceByPin = new Set(attendanceEntries.map(entry => String(entry.pin)));

        const enrichedPersons = admsPersons.map(person => {
            const photoInfo = resolvePersonPhotoInfo(person.pin, person.photo || '');
            const hasAttendance = attendanceByPin.has(String(person.pin));
            return {
                nuip: person.nuip || null,
                pin: person.pin,
                name: person.name,
                photo: person.photo,
                photoDbValue: photoInfo.photoDbValue,
                photoFileExists: photoInfo.photoFileExists,
                photoResolvedPath: photoInfo.photoResolvedPath,
                imageSize: person.imageSize,
                userCommandId: person.userCommandId,
                biophotoCommandId: person.biophotoCommandId,
                biodataCommandId: person.biodataCommandId,
                hasAttendance,
                attendanceConfirmed: hasAttendance,
                hasPhoto: photoInfo.hasPhoto,
                hasBiodata: false,
                status: person.status || 'activo',
                deviceSyncStatus: person.deviceSyncStatus || computeDeviceSyncStatusForPin(person.pin),
                siteId: person.siteId || null,
                targetDeviceSn: person.targetDeviceSn || null,
                createdAt: person.createdAt,
                updatedAt: person.updatedAt
            };
        });

        return {
            ...applyAdditionalFilters(applyPersonScope(enrichedPersons)),
            source: 'adms-local'
        };
    }
}

async function performSafeAdmsEnrollment({ body, file }) {
    const pin = normalizePin(body.pin);
    const rawName = typeof body.name === 'string' ? body.name : '';
    const name = normalizeAdmsQueueField(rawName, 24, true);
    const rawPassword = typeof body.password === 'string' ? body.password : '';
    const password = normalizeAdmsQueueField(rawPassword, 24, false);
    const imageMode = normalizeImageMode(body.imageMode || DEFAULT_ADMS_IMAGE_MODE);
    const profilePin = normalizeProfilePin(body.profilePin || DEFAULT_ADMS_PROFILE_PIN);
    const contentTerminator = normalizeContentTerminator(body.contentTerminator || DEFAULT_ADMS_CONTENT_TERMINATOR);

    if (!pin || !name || !password) {
        const error = new Error('Debes enviar pin, name y password validos');
        error.statusCode = 400;
        throw error;
    }

    if (!file) {
        const error = new Error('Debes enviar image en multipart/form-data');
        error.statusCode = 400;
        throw error;
    }

    validateExplicitSiteDeviceAccess(body.siteId, body.targetDeviceSn);
    const targetContext = resolveCommandTargetMetadata(body);
    const enrollment = await enqueueAdmsPhotoEnrollment({
        pin,
        name,
        password,
        tempFilePath: file.path,
        imageMode,
        profilePin,
        contentTerminator,
        ...targetContext
    });

    await syncEnrolledPersonState({
        pin,
        name,
        photo: enrollment.savedPhoto
    });

    persistAdmsPerson({
        pin,
        name,
        photo: enrollment.savedPhoto,
        imageSize: enrollment.imageSize,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        siteId: targetContext.siteId,
        targetDeviceSn: targetContext.targetDeviceSn
    });

    return {
        ok: true,
        pin,
        name,
        siteId: targetContext.siteId,
        targetDeviceSn: targetContext.targetDeviceSn,
        deviceName: targetContext.deviceName,
        locationName: targetContext.locationName,
        imageMode: enrollment.imageMode,
        profilePin: enrollment.profilePin,
        contentTerminator: enrollment.contentTerminator,
        userCommandId: enrollment.userCommandId,
        biophotoCommandId: enrollment.biophotoCommandId,
        savedPhoto: enrollment.savedPhoto,
        originalImageSize: enrollment.originalImageSize,
        finalImageSize: enrollment.finalImageSize,
        originalHash: enrollment.originalHash,
        finalHash: enrollment.finalHash,
        imageSize: enrollment.imageSize,
        message: 'Persona encolada para enrolamiento ADMS'
    };
}

async function performApiDeviceProfileUpdate({ nuip, body, file }) {
    const normalizedNuip = normalizeNuip(nuip);
    const rawName = typeof body.name === 'string' ? body.name : '';
    const rawPassword = typeof body.password === 'string' ? body.password : '';
    const explicitPin = normalizePin(body.pin_dispositivo || body.pinDispositivo || body.pin);
    const wantsName = String(rawName || '').trim() !== '';
    const wantsPassword = String(rawPassword || '').trim() !== '';
    const wantsPhoto = Boolean(file);

    if (!normalizedNuip) {
        const error = new Error('nuip requerido');
        error.statusCode = 400;
        throw error;
    }

    if (!wantsName && !wantsPassword && !wantsPhoto) {
        const error = new Error('Debes enviar al menos image, password o name');
        error.statusCode = 400;
        throw error;
    }

    const requestedSiteId = normalizeRecordsScopeValue(body.siteId);
    const requestedTargetDeviceSn = normalizeRecordsScopeValue(body.targetDeviceSn);
    const pinDispositivo = explicitPin;

    if (!pinDispositivo) {
        const error = new Error('pin_dispositivo requerido en esta version experimental');
        error.statusCode = 400;
        throw error;
    }

    const finalSiteId = requestedSiteId;
    const finalTargetDeviceSn = requestedTargetDeviceSn;
    validateExplicitSiteDeviceAccess(finalSiteId, finalTargetDeviceSn);
    const targetContext = resolveCommandTargetMetadata({
        pin: pinDispositivo,
        siteId: finalSiteId,
        targetDeviceSn: finalTargetDeviceSn
    });
    const localPerson = readLatestAdmsPersonByPin(pinDispositivo);
    const dbPerson = await readDbPersonByPin(pinDispositivo);
    const resolvedLocalName = String(localPerson?.name || dbPerson?.name || '').trim();
    const nextName = wantsName
        ? normalizeAdmsQueueField(rawName, 24, true)
        : resolvedLocalName;
    const nextPassword = wantsPassword
        ? normalizeAdmsQueueField(rawPassword, 24, false)
        : '';
    const needsUserinfo = wantsName || wantsPassword;

    if (wantsName && !nextName) {
        const error = new Error('Parametro name invalido');
        error.statusCode = 400;
        throw error;
    }

    if (wantsPassword && !nextPassword) {
        const error = new Error('Parametro password invalido');
        error.statusCode = 400;
        throw error;
    }

    if (wantsName && !wantsPassword) {
        const error = new Error('USERINFO requiere password explicito cuando envias name');
        error.statusCode = 400;
        throw error;
    }

    if (wantsPassword && !nextName) {
        const error = new Error('No se pudo resolver un nombre local confiable para construir USERINFO. Envia name.');
        error.statusCode = 400;
        throw error;
    }
    if (needsUserinfo && !nextPassword) {
        const error = new Error('No se pudo resolver la contraseÃ±a actual para construir USERINFO. Envia password.');
        error.statusCode = 400;
        throw error;
    }

    const imageMode = 'device-biophoto-profile';
    const profilePin = normalizeProfilePin(body.profilePin || pinDispositivo);
    const contentTerminator = normalizeContentTerminator(body.contentTerminator || DEFAULT_ADMS_CONTENT_TERMINATOR);
    let userinfoResult = null;
    let photoResult = null;
    const commandRefs = [];

    if (wantsPhoto && needsUserinfo) {
        photoResult = await enqueueAdmsPhotoEnrollment({
            pin: pinDispositivo,
            name: nextName,
            password: nextPassword,
            tempFilePath: file.path,
            imageMode,
            profilePin,
            contentTerminator,
            ...targetContext
        });
        userinfoResult = {
            commandId: photoResult.userCommandId,
            commandType: 'USERINFO'
        };
        commandRefs.push(userinfoResult, {
            commandId: photoResult.biophotoCommandId,
            commandType: 'BIOPHOTO'
        });
    } else {
        if (needsUserinfo) {
            const userCommand = enqueueAdmsUserinfoCommand({
                pin: pinDispositivo,
                name: nextName,
                password: nextPassword,
                verify: 0,
                ...targetContext
            });
            userinfoResult = {
                commandId: userCommand.commandId,
                commandType: 'USERINFO'
            };
            commandRefs.push(userinfoResult);
        }

        if (wantsPhoto) {
            photoResult = await enqueueAdmsBiophotoOnly({
                pin: pinDispositivo,
                tempFilePath: file.path,
                imageMode,
                profilePin,
                contentTerminator,
                ...targetContext
            });
            commandRefs.push({
                commandId: photoResult.biophotoCommandId,
                commandType: 'BIOPHOTO'
            });
        }
    }

    const persistedName = nextName || localPerson?.name || dbPerson?.name || `PIN_${pinDispositivo}`;
    const persistedPhoto = photoResult?.savedPhoto || localPerson?.photo || '';

    if (wantsName || wantsPhoto) {
        await syncEnrolledPersonState({
            pin: pinDispositivo,
            name: persistedName,
            photo: persistedPhoto
        });
    }

    persistAdmsPerson({
        nuip: normalizedNuip,
        pin: pinDispositivo,
        name: persistedName,
        photo: persistedPhoto,
        imageSize: photoResult?.imageSize || localPerson?.imageSize || null,
        userCommandId: userinfoResult?.commandId || localPerson?.userCommandId || null,
        biophotoCommandId: photoResult?.biophotoCommandId || localPerson?.biophotoCommandId || null,
        siteId: targetContext.siteId,
        targetDeviceSn: targetContext.targetDeviceSn
    });

    return {
        ok: true,
        message: 'Perfil de dispositivo actualizado',
        nuip: normalizedNuip,
        pin_dispositivo: pinDispositivo,
        updated: {
            name: wantsName,
            password: wantsPassword,
            photo: wantsPhoto
        },
        commands: resolveDeviceProfileCommandStatuses(commandRefs)
    };
}

async function performMysqlPersonPatchWithOptionalDeviceSync({ nuip, body, file, entidadId = null }) {
    const normalizedNuip = normalizeNuip(nuip);
    const normalizedEntidadId = normalizePositiveIntegerId(entidadId);
    if (!normalizedNuip) {
        const error = new Error('nuip requerido');
        error.statusCode = 400;
        throw error;
    }

    const personPayload = await buildMysqlPersonPayloadFromPublicBody(body || {}, { entidad_id: normalizedEntidadId });

    const hasPersonPayload = Object.keys(personPayload).length > 0;

    // Read current person first to check state and existence before any update
    let person = await readMysqlPersonByNuip(normalizedNuip, { entidad_id: normalizedEntidadId });
    if (!person) {
        const error = new Error('Persona no encontrada');
        error.statusCode = 404;
        throw error;
    }

    // PATCH should not operate on inactive persons: reject with 409
    if (String(person.estado || '').trim().toLowerCase() === 'inactivo') {
        const error = new Error('La persona está inactiva. Reactívala usando POST antes de actualizarla.');
        error.statusCode = 409;
        error.code = 'PERSON_INACTIVE';
        throw error;
    }

    const rawPassword = typeof body.password === 'string' ? body.password : '';
    const explicitPinDispositivo = normalizePin(body.pin_dispositivo || body.pinDispositivo || body.pin);
    const requestedTargetDeviceSn = normalizeRecordsScopeValue(body.targetDeviceSn);
    const wantsPhoto = Boolean(file);
    const wantsPassword = String(rawPassword || '').trim() !== '';
    const wantsDeviceFields = Boolean(explicitPinDispositivo || requestedTargetDeviceSn || wantsPhoto || wantsPassword || toBooleanFlag(body.syncDevice));

    if (!wantsDeviceFields) {
        if (hasPersonPayload) {
            person = await updateMysqlPersonByNuip(normalizedNuip, personPayload, { entidad_id: normalizedEntidadId });
        }

        return {
            ok: true,
            message: 'Persona actualizada',
            person,
            deviceSync: {
                requested: false
            }
        };
    }

    const deviceProfiles = Array.isArray(person.persona_dispositivos) ? person.persona_dispositivos : [];
    const currentRelation = deviceProfiles.find(entry =>
        String(entry.numero_serie || '') === requestedTargetDeviceSn ||
        normalizePositiveIntegerId(entry.dispositivo_id) === normalizePositiveIntegerId(requestedTargetDeviceSn)
    ) || (deviceProfiles.length === 1 ? deviceProfiles[0] : null);
    // En API pública v2, si no se envia pin_dispositivo ni existe relacion, usamos nuip como PIN tecnico
    const explicitPin = explicitPinDispositivo || normalizePin(currentRelation?.pin_dispositivo) || normalizedNuip;

    let resolvedTargetDeviceSn = requestedTargetDeviceSn;
    if (!resolvedTargetDeviceSn && currentRelation) {
        resolvedTargetDeviceSn = String(currentRelation.numero_serie || '').trim();
        if (!resolvedTargetDeviceSn && currentRelation.dispositivo_id) {
            const deviceById = await readMysqlDeviceById(currentRelation.dispositivo_id);
            resolvedTargetDeviceSn = String(deviceById?.numero_serie || '').trim();
        }
    }

    if (!resolvedTargetDeviceSn) {
        const error = new Error('targetDeviceSn requerido cuando solicitas sincronizacion con dispositivo. Envía targetDeviceSn o usa una persona con relación existente.');
        error.statusCode = 400;
        throw error;
    }

    const finalTargetDeviceSn = resolvedTargetDeviceSn;
    const pinDispositivo = explicitPin; // explicitPin ya contiene fallback a nuip
    const mysqlDevice = await assertMysqlPersonDeviceAssignmentAllowed({
        personId: person.id,
        entidadId: normalizedEntidadId || person.entidad_id,
        targetDeviceSn: finalTargetDeviceSn,
        pinDispositivo
    });

    if (hasPersonPayload) {
        person = await updateMysqlPersonByNuip(normalizedNuip, personPayload, { entidad_id: normalizedEntidadId });
    }

    const resolvedFullName = String(person.nombre_completo || buildPersonFullName(person.nombres, person.apellidos) || '').trim();

    const targetContext = resolveCommandTargetMetadata({
        targetDeviceSn: finalTargetDeviceSn
    });

    const wantsNameSync = body.name !== undefined || body.nombre_completo !== undefined || body.nombres !== undefined || body.apellidos !== undefined;

    if ((wantsPassword || wantsNameSync) && !resolvedFullName) {
        const error = new Error('No hay un nombre confiable en MySQL para construir USERINFO. Envia name.');
        error.statusCode = 400;
        throw error;
    }

    const admsName = resolvedFullName ? normalizeAdmsQueueField(resolvedFullName, 24, true) : '';
    if ((wantsPassword || wantsNameSync) && !admsName) {
        const error = new Error('No se pudo normalizar un name valido para USERINFO.');
        error.statusCode = 400;
        throw error;
    }

    const admsPassword = wantsPassword ? normalizeAdmsQueueField(rawPassword, 24, false) : '';
    if (wantsPassword && !admsPassword) {
        const error = new Error('Parametro password invalido');
        error.statusCode = 400;
        throw error;
    }

    const needsUserinfo = wantsPassword || wantsNameSync;
    const profilePin = normalizeProfilePin(body.profilePin || pinDispositivo);
    const contentTerminator = normalizeContentTerminator(body.contentTerminator || DEFAULT_ADMS_CONTENT_TERMINATOR);
    const commandRefs = [];
    let photoResult = null;
    let userinfoResult = null;

    if (wantsPhoto && needsUserinfo) {
        photoResult = await enqueueAdmsPhotoEnrollment({
            pin: pinDispositivo,
            name: admsName,
            password: admsPassword,
            tempFilePath: file.path,
            imageMode: 'device-biophoto-profile',
            profilePin,
            contentTerminator,
            ...targetContext
        });
        userinfoResult = {
            commandId: photoResult.userCommandId,
            commandType: 'USERINFO'
        };
        commandRefs.push(userinfoResult, {
            commandId: photoResult.biophotoCommandId,
            commandType: 'BIOPHOTO'
        });
    } else {
        if (needsUserinfo) {
            const userCommand = enqueueAdmsUserinfoCommand({
                pin: pinDispositivo,
                name: admsName,
                password: admsPassword,
                verify: 0,
                ...targetContext
            });
            userinfoResult = {
                commandId: userCommand.commandId,
                commandType: 'USERINFO'
            };
            commandRefs.push(userinfoResult);
        }

        if (wantsPhoto) {
            photoResult = await enqueueAdmsBiophotoOnly({
                pin: pinDispositivo,
                tempFilePath: file.path,
                imageMode: 'device-biophoto-profile',
                profilePin,
                contentTerminator,
                ...targetContext
            });
            commandRefs.push({
                commandId: photoResult.biophotoCommandId,
                commandType: 'BIOPHOTO'
            });
        }
    }

    const commandStatuses = resolveDeviceProfileCommandStatuses(commandRefs);
    const lastCommandId = commandStatuses.length > 0 ? commandStatuses[commandStatuses.length - 1].commandId : null;
    await ensureMysqlPersonDeviceRelation({
        personId: person.id,
        deviceId: mysqlDevice.id,
        pinDispositivo,
        lastCommandId,
        status: commandStatuses.some(entry => entry.status === 'accepted') ? 'accepted' : 'pending'
    });

    persistAdmsPerson({
        nuip: normalizedNuip,
        pin: pinDispositivo,
        name: admsName || resolvedFullName || `PIN_${pinDispositivo}`,
        photo: photoResult?.savedPhoto || '',
        imageSize: photoResult?.imageSize || null,
        userCommandId: userinfoResult?.commandId || null,
        biophotoCommandId: photoResult?.biophotoCommandId || null,
        siteId: targetContext.siteId,
        targetDeviceSn: targetContext.targetDeviceSn
    });

    if (wantsPhoto || needsUserinfo) {
        await syncEnrolledPersonState({
            pin: pinDispositivo,
            name: admsName || resolvedFullName || `PIN_${pinDispositivo}`,
            photo: photoResult?.savedPhoto || ''
        });
    }

    person = await readMysqlPersonByNuip(normalizedNuip, { entidad_id: normalizedEntidadId });
    return {
        ok: true,
        message: 'Persona actualizada',
        person,
        deviceSync: {
            requested: true,
            targetDeviceSn: targetContext.targetDeviceSn,
            pin_dispositivo: pinDispositivo,
            commands: commandStatuses
        }
    };
}

async function buildApiHealthPayload() {
    let databaseConnected = false;
    let databaseError = null;

    try {
        await db.query('SELECT 1');
        databaseConnected = true;
    } catch (error) {
        databaseError = error.message;
    }

    return {
        ok: true,
        estado: 'Servidor activo',
        puerto: config.server.port,
        server: {
            port: config.server.port
        },
        database: {
            engine: 'mysql',
            name: config.mysql.database,
            connected: databaseConnected,
            error: databaseError
        },
        tcpZk: config.zk.ip
            ? {
                enabled: true,
                ip: config.zk.ip,
                port: config.zk.port,
                timeoutMs: config.zk.timeoutMs
            }
            : {
                enabled: false
            }
    };
}

function requestLooksLikeMysqlPersonsList(req) {
    const query = req.query || {};
    const legacyKeys = ['scope', 'siteId', 'sn', 'targetDeviceSn', 'pin', 'status'];
    return !legacyKeys.some(key => query[key] !== undefined);
}

function requestLooksLikeMysqlPersonMutation(req) {
    const body = req.body || {};
    const mysqlKeys = ['name', 'nombres', 'apellidos', 'nombre_completo', 'entidad_id', 'estado'];
    return mysqlKeys.some(key => body[key] !== undefined);
}

function authorizeDeviceForSite(siteId, sn) {
    const normalizedSiteId = String(siteId || '').trim();
    const normalizedSn = String(sn || '').trim();

    if (!normalizedSiteId || !normalizedSn) {
        const error = new Error('Debes enviar siteId y sn validos');
        error.statusCode = 400;
        throw error;
    }

    const sites = readAdmsSites();
    const siteIndex = sites.findIndex(site => String(site.siteId || '').trim() === normalizedSiteId);
    if (siteIndex < 0) {
        const error = new Error(`La sede ${normalizedSiteId} no existe`);
        error.statusCode = 404;
        throw error;
    }

    const currentAllowed = Array.isArray(sites[siteIndex].allowedDeviceSns) ? sites[siteIndex].allowedDeviceSns : [];
    sites[siteIndex] = {
        ...sites[siteIndex],
        allowedDeviceSns: Array.from(new Set([...currentAllowed, normalizedSn]))
    };
    const updatedSites = writeAdmsSites(sites);
    const device = updateAdmsDeviceConfig(normalizedSn, {
        siteId: normalizedSiteId,
        enabled: true
    });

    return {
        site: updatedSites.find(site => String(site.siteId || '').trim() === normalizedSiteId) || sites[siteIndex],
        device
    };
}

function deauthorizeDeviceForSite(siteId, sn) {
    const normalizedSiteId = String(siteId || '').trim();
    const normalizedSn = String(sn || '').trim();

    if (!normalizedSiteId || !normalizedSn) {
        const error = new Error('Debes enviar siteId y sn validos');
        error.statusCode = 400;
        throw error;
    }

    const sites = readAdmsSites();
    const siteIndex = sites.findIndex(site => String(site.siteId || '').trim() === normalizedSiteId);
    if (siteIndex < 0) {
        const error = new Error(`La sede ${normalizedSiteId} no existe`);
        error.statusCode = 404;
        throw error;
    }

    sites[siteIndex] = {
        ...sites[siteIndex],
        allowedDeviceSns: (Array.isArray(sites[siteIndex].allowedDeviceSns) ? sites[siteIndex].allowedDeviceSns : [])
            .filter(value => String(value || '').trim() !== normalizedSn)
    };
    const updatedSites = writeAdmsSites(sites);

    const devices = readJsonLinesFile(admsDevicesLogPath);
    const deviceIndex = devices.findIndex(entry => String(entry.sn || '').trim() === normalizedSn);
    if (deviceIndex >= 0) {
        devices[deviceIndex] = {
            ...devices[deviceIndex],
            enabled: false,
            siteId: 'unassigned'
        };
        writeJsonLinesFile(admsDevicesLogPath, devices);
    }

    return {
        site: updatedSites.find(site => String(site.siteId || '').trim() === normalizedSiteId) || sites[siteIndex],
        device: getAdmsDeviceBySn(normalizedSn)
    };
}

function rebuildAdmsPersonsFromFiles() {
    const previousByPin = new Map(readLatestAdmsPersons().map(entry => [entry.pin, entry]));
    const rebuilt = fs.readdirSync(facesUploadsDir)
        .map(fileName => {
            const match = fileName.match(/^(\d+)\.jpg$/i);
            if (!match) {
                return null;
            }

            const pin = match[1];
            const absolutePath = path.join(facesUploadsDir, fileName);
            const stats = fs.statSync(absolutePath);
            const previous = previousByPin.get(pin);
            const timestamp = resolveFileTimestamp(stats);

            return {
                pin,
                name: previous?.name || `PIN_${pin}`,
                photo: `uploads/faces/${fileName}`,
                imageSize: stats.size,
                userCommandId: previous?.userCommandId || null,
                biophotoCommandId: previous?.biophotoCommandId || null,
                createdAt: previous?.createdAt || timestamp,
                updatedAt: timestamp
            };
        })
        .filter(Boolean)
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const fileContent = rebuilt.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(admsPersonsLogPath, fileContent ? `${fileContent}\n` : '');

    return rebuilt.map(entry => ({
        pin: entry.pin,
        name: entry.name,
        photo: entry.photo,
        imageSize: entry.imageSize,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
    }));
}

function resolveFileTimestamp(stats) {
    const candidate = stats.birthtime instanceof Date && !Number.isNaN(stats.birthtime.getTime())
        ? stats.birthtime
        : stats.mtime;
    return candidate instanceof Date && !Number.isNaN(candidate.getTime())
        ? candidate.toISOString()
        : new Date().toISOString();
}

function normalizeAdmsQueueField(value, maxLength, useNameSanitizer) {
    const baseValue = useNameSanitizer ? normalizeAdmsCommandName(value) : String(value || '').replace(/[^\x20-\x7E]/g, '');
    return baseValue.replace(/[\t\r\n=]/g, '').slice(0, maxLength);
}

function enqueueAdmsUserinfoCommand({ pin, name, password, verify, targetDeviceSn, siteId, deviceName, locationName }) {
    const commandId = allocateAdmsCommandId();
    const command = `C:${commandId}:DATA UPDATE USERINFO PIN=${pin}\tName=${name}\tPri=0\tPasswd=${password}\tCard=\tGrp=1\tTZ=0000000100000000\tVerify=${verify}\tViceCard=\tStartDatetime=0\tEndDatetime=0`;
    enqueueAdmsCommandEntry({
        commandId,
        commandType: 'USERINFO',
        pin,
        command,
        targetDeviceSn,
        siteId,
        deviceName,
        locationName
    });

    return {
        commandId,
        command
    };
}

async function enqueueAdmsPhotoEnrollment({ pin, name, password, tempFilePath, imageMode = 'raw', profilePin = DEFAULT_ADMS_PROFILE_PIN, contentTerminator = 'none', targetDeviceSn, siteId, deviceName, locationName }) {
    const savedFileName = `${pin}.jpg`;
    const savedFilePath = path.join(facesUploadsDir, savedFileName);
    const normalizedMode = normalizeImageMode(imageMode);
    const normalizedProfilePin = normalizeProfilePin(profilePin);
    const normalizedContentTerminator = normalizeContentTerminator(contentTerminator);
    const { originalImageSize, finalImageSize, originalHash, finalHash, imageBuffer } = await normalizeFaceImage({
        pin,
        tempFilePath,
        savedFilePath,
        imageMode: normalizedMode
    });
    const imageBase64 = imageBuffer.toString('base64');
    const imageSize = imageBuffer.length;
    const userCommand = enqueueAdmsUserinfoCommand({
        pin,
        name,
        password,
        verify: 0,
        targetDeviceSn,
        siteId,
        deviceName,
        locationName
    });

    const biophotoCommandId = allocateAdmsCommandId();
    const contentSuffix = normalizedContentTerminator === 'comma' ? ',' : '';
    const biophotoCommand = `C:${biophotoCommandId}:DATA UPDATE BIOPHOTO PIN=${pin}\tNo=0\tIndex=0\tFileName=${pin}.jpg\tType=9\tSize=${imageSize}\tContent=${imageBase64}${contentSuffix}`;
    admsCommandMetadataById.set(String(biophotoCommandId), {
        imageMode: normalizedMode,
        profilePin: normalizedProfilePin,
        contentTerminator: normalizedContentTerminator
    });
    enqueueAdmsCommandEntry({
        commandId: biophotoCommandId,
        commandType: 'BIOPHOTO',
        pin,
        command: biophotoCommand,
        targetDeviceSn,
        siteId,
        deviceName,
        locationName
    });

    return {
        imageMode: normalizedMode,
        profilePin: normalizedProfilePin,
        contentTerminator: normalizedContentTerminator,
        userCommandId: userCommand.commandId,
        biophotoCommandId,
        savedPhoto: `uploads/faces/${savedFileName}`,
        originalImageSize,
        finalImageSize,
        originalHash,
        finalHash,
        imageSize
    };
}

async function enqueueAdmsBiophotoOnly({ pin, tempFilePath, imageMode = 'device-biophoto-profile', profilePin = DEFAULT_ADMS_PROFILE_PIN, contentTerminator = 'none', targetDeviceSn, siteId, deviceName, locationName }) {
    const savedFileName = `${pin}.jpg`;
    const savedFilePath = path.join(facesUploadsDir, savedFileName);
    const normalizedMode = normalizeImageMode(imageMode);
    const normalizedProfilePin = normalizeProfilePin(profilePin);
    const normalizedContentTerminator = normalizeContentTerminator(contentTerminator);
    const { originalImageSize, finalImageSize, originalHash, finalHash, imageBuffer } = await normalizeFaceImage({
        pin,
        tempFilePath,
        savedFilePath,
        imageMode: normalizedMode
    });
    const imageBase64 = imageBuffer.toString('base64');
    const imageSize = imageBuffer.length;
    const biophotoCommandId = allocateAdmsCommandId();
    const contentSuffix = normalizedContentTerminator === 'comma' ? ',' : '';
    const biophotoCommand = `C:${biophotoCommandId}:DATA UPDATE BIOPHOTO PIN=${pin}\tNo=0\tIndex=0\tFileName=${pin}.jpg\tType=9\tSize=${imageSize}\tContent=${imageBase64}${contentSuffix}`;
    admsCommandMetadataById.set(String(biophotoCommandId), {
        imageMode: normalizedMode,
        profilePin: normalizedProfilePin,
        contentTerminator: normalizedContentTerminator
    });
    enqueueAdmsCommandEntry({
        commandId: biophotoCommandId,
        commandType: 'BIOPHOTO',
        pin,
        command: biophotoCommand,
        targetDeviceSn,
        siteId,
        deviceName,
        locationName
    });

    return {
        imageMode: normalizedMode,
        profilePin: normalizedProfilePin,
        contentTerminator: normalizedContentTerminator,
        biophotoCommandId,
        savedPhoto: `uploads/faces/${savedFileName}`,
        originalImageSize,
        finalImageSize,
        originalHash,
        finalHash,
        imageSize
    };
}

async function normalizeFaceImage({ pin, tempFilePath, savedFilePath, imageMode }) {
    const originalImageSize = fs.statSync(tempFilePath).size;
    const originalHash = calculateFileSha256(tempFilePath);
    const normalizedMode = normalizeImageMode(imageMode);

    if (normalizedMode === 'raw') {
        fs.copyFileSync(tempFilePath, savedFilePath);
    } else {
        const imagePipeline = sharp(tempFilePath)
            .rotate()
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .toColorspace('srgb');

        if (normalizedMode === 'resize-inside-480') {
            imagePipeline.resize(480, 480, {
                fit: 'inside',
                withoutEnlargement: true
            });
        } else if (normalizedMode === 'square-contain-480') {
            imagePipeline.resize(480, 480, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 1 },
                withoutEnlargement: true
            });
        } else if (normalizedMode === 'square-cover-480') {
            imagePipeline.resize(480, 480, {
                fit: 'cover',
                position: 'centre'
            });
        } else if (normalizedMode === 'known-working-upload-profile' || normalizedMode === 'device-biophoto-profile') {
            imagePipeline.resize(640, 640, {
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        await imagePipeline
            .jpeg({
                quality: normalizedMode === 'device-biophoto-profile' ? 82 : 80,
                progressive: false,
                mozjpeg: false,
                chromaSubsampling: '4:2:0'
            })
            .toFile(savedFilePath);
    }

    if (path.resolve(tempFilePath) !== path.resolve(savedFilePath) && fs.existsSync(tempFilePath)) {
        safeUnlink(tempFilePath, 'normalizeFaceImage');
    }

    const imageBuffer = fs.readFileSync(savedFilePath);
    return {
        pin,
        originalImageSize,
        finalImageSize: imageBuffer.length,
        originalHash,
        finalHash: sha256Buffer(imageBuffer),
        imageBuffer
    };
}

function safeUnlink(filePath, context = '') {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        if (['EPERM', 'EBUSY', 'ENOENT'].includes(String(error.code || ''))) {
            logStore.warn('filesystem.unlink.skipped', {
                code: error.code || null,
                filePath,
                context: context || null
            });
            return false;
        }

        throw error;
    }

    return true;
}

function normalizeImageMode(value) {
    const mode = String(value || '').trim();
    const allowedModes = new Set([
        'raw',
        'resize-inside-480',
        'square-contain-480',
        'square-cover-480',
        'known-working-upload-profile',
        'device-biophoto-profile'
    ]);

    return allowedModes.has(mode) ? mode : DEFAULT_ADMS_IMAGE_MODE;
}

function normalizeProfilePin(value) {
    const normalized = normalizePin(value);
    return normalized || DEFAULT_ADMS_PROFILE_PIN;
}

function normalizeContentTerminator(value) {
    return String(value || '').trim().toLowerCase() === 'comma' ? 'comma' : DEFAULT_ADMS_CONTENT_TERMINATOR;
}

function calculateFileSha256(filePath) {
    return sha256Buffer(fs.readFileSync(filePath));
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function enqueueAdmsBiodataFromSource(sourcePin, targetPin, targetOptions = {}) {
    const biodataEntries = readJsonLinesFile(admsBiodataLogPath);
    const latestBiodata = findLatestAdmsEntry(biodataEntries, sourcePin, '9');

    if (!latestBiodata) {
        const error = new Error(`No existe BIODATA Type=9 para sourceFacePin ${sourcePin}`);
        error.statusCode = 404;
        throw error;
    }

    const biodataCommandId = allocateAdmsCommandId();
    const biodataCommand = `C:${biodataCommandId}:DATA UPDATE BIODATA Pin=${targetPin}\tNo=${latestBiodata.no}\tIndex=${latestBiodata.index}\tValid=1\tDuress=0\tType=9\tMajorVer=${latestBiodata.majorVer}\tMinorVer=${latestBiodata.minorVer}\tFormat=${latestBiodata.format}\tTmp=${latestBiodata.tmp}`;
    enqueueAdmsCommandEntry({
        commandId: biodataCommandId,
        commandType: 'BIODATA',
        pin: targetPin,
        command: biodataCommand,
        ...targetOptions
    });
    return biodataCommandId;
}

function enqueueAdmsFaceCopyCommands(sourcePin, targetPin, targetOptions = {}) {
    const biophotoEntries = readJsonLinesFile(admsBiophotoLogPath);
    const biodataEntries = readJsonLinesFile(admsBiodataLogPath);
    const latestBiophoto = findLatestAdmsEntry(biophotoEntries, sourcePin, '9');
    const latestBiodata = findLatestAdmsEntry(biodataEntries, sourcePin, '9');

    if (!latestBiophoto) {
        const error = new Error(`No existe BIOPHOTO Type=9 para sourcePin ${sourcePin}`);
        error.statusCode = 404;
        throw error;
    }

    if (!latestBiodata) {
        const error = new Error(`No existe BIODATA Type=9 para sourcePin ${sourcePin}`);
        error.statusCode = 404;
        throw error;
    }

    const biophotoFileName = String(latestBiophoto.savedAs || `${latestBiophoto.pin}-${latestBiophoto.type}-${latestBiophoto.index}.jpg`);
    const biophotoFilePath = path.join(biophotosDir, biophotoFileName);
    if (!fs.existsSync(biophotoFilePath)) {
        const error = new Error(`No existe el archivo BIOPHOTO ${biophotoFileName}`);
        error.statusCode = 404;
        throw error;
    }

    const biophotoBase64 = fs.readFileSync(biophotoFilePath).toString('base64');
    const biophotoCommandId = allocateAdmsCommandId();
    const biodataCommandId = allocateAdmsCommandId();
    const biophotoCommand = `C:${biophotoCommandId}:DATA UPDATE BIOPHOTO PIN=${targetPin}\tNo=${latestBiophoto.no}\tIndex=${latestBiophoto.index}\tFileName=${targetPin}.jpg\tType=9\tSize=${latestBiophoto.size}\tContent=${biophotoBase64}`;
    const biodataCommand = `C:${biodataCommandId}:DATA UPDATE BIODATA Pin=${targetPin}\tNo=${latestBiodata.no}\tIndex=${latestBiodata.index}\tValid=1\tDuress=0\tType=9\tMajorVer=35\tMinorVer=4\tFormat=0\tTmp=${latestBiodata.tmp}`;

    enqueueAdmsCommandEntry({
        commandId: biophotoCommandId,
        commandType: 'BIOPHOTO',
        pin: targetPin,
        command: biophotoCommand,
        ...targetOptions
    });
    enqueueAdmsCommandEntry({
        commandId: biodataCommandId,
        commandType: 'BIODATA',
        pin: targetPin,
        command: biodataCommand,
        ...targetOptions
    });

    return {
        commandIds: {
            biophoto: biophotoCommandId,
            biodata: biodataCommandId
        },
        summary: {
            biophoto: {
                no: latestBiophoto.no,
                index: latestBiophoto.index,
                type: latestBiophoto.type,
                size: latestBiophoto.size,
                fileName: `${targetPin}.jpg`
            },
            biodata: {
                no: latestBiodata.no,
                index: latestBiodata.index,
                type: latestBiodata.type,
                majorVer: latestBiodata.majorVer,
                minorVer: latestBiodata.minorVer,
                format: latestBiodata.format
            }
        }
    };
}

function findLatestAdmsEntry(entries, pin, type) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (String(entry.pin || '') === String(pin) && String(entry.type || '') === String(type)) {
            return entry;
        }
    }

    return null;
}

function readAttendanceEntries(filters = {}) {
    const pin = String(filters.pin || '').trim();
    const from = normalizeDateFilter(filters.from);
    const to = normalizeDateFilter(filters.to);
    const limit = normalizeAttendanceLimit(filters.limit);
    const activeSn = normalizeRecordsScopeValue(filters.sn || filters.targetDeviceSn);
    const siteId = normalizeRecordsScopeValue(filters.siteId);
    const scopeFilters = {
        scopeAll: filters.scopeAll === true || (!activeSn && !siteId),
        activeSn,
        siteId
    };

    let entries = readJsonLinesFile(admsAttlogLogPath)
        .filter(entry => !pin || entry.pin === pin)
        .filter(entry => matchesScopedRecord(entry, scopeFilters, { snFields: ['sn'], siteIdFields: ['siteId'] }))
        .filter(entry => {
            const entryDate = String(entry.timestamp || '').slice(0, 10);
            if (from && entryDate < from) {
                return false;
            }

            if (to && entryDate > to) {
                return false;
            }

            return true;
        })
        .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));

    if (limit > 0) {
        entries = entries.slice(0, limit);
    }

    return entries;
}

function buildAttendanceSummary(pin, date) {
    const checks = readAttendanceEntries({ pin, from: date, to: date })
        .slice()
        .reverse()
        .map(entry => ({
            timestamp: entry.timestamp,
            verifyMode: entry.verifyMode,
            sn: entry.sn
        }));

    return {
        pin,
        date,
        firstCheck: checks.length > 0 ? checks[0].timestamp : null,
        lastCheck: checks.length > 0 ? checks[checks.length - 1].timestamp : null,
        totalChecks: checks.length,
        checks
    };
}

function normalizeDateFilter(value) {
    const raw = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function normalizeAttendanceLimit(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return 0;
    }

    return Math.min(parsed, 1000);
}

function getRawIclockBody(req) {
    return typeof req.body === 'string' ? req.body : '';
}

function sendPlainText(res, body) {
    res.type('text/plain');
    res.send(body);
}

function isMysqlCommandDispatchEnabled() {
    return String(process.env.ENABLE_MYSQL_COMMAND_DISPATCH || '').toLowerCase() === 'true';
}

async function flushPendingMysqlCommands(deviceSn = '') {
    const normalizedDeviceSn = String(deviceSn || '').trim() || DEFAULT_TARGET_DEVICE_SN;
    const limit = 5;
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.query(`
            SELECT id, command_text
            FROM adms_commands
            WHERE target_device_sn = ?
              AND status IN ('queued', 'retry_pending')
            ORDER BY id ASC
            LIMIT ?
            FOR UPDATE
        `, [normalizedDeviceSn, limit]);

        const commands = Array.isArray(rows) ? rows : [];
        if (commands.length === 0) {
            await connection.commit();
            return '';
        }

        const ids = commands.map(command => command.id);
        const placeholders = ids.map(() => '?').join(', ');
        await connection.query(`
            UPDATE adms_commands
            SET status = 'sent_waiting_ack',
                sent_at = CURRENT_TIMESTAMP,
                request_device_sn = ?,
                request_attempts = request_attempts + 1,
                locked_at = NULL
            WHERE id IN (${placeholders})
        `, [normalizedDeviceSn, ...ids]);

        await connection.commit();

        const response = commands.map(command => String(command.command_text || '')).join('\r\n');
        logStore.info('adms.commands.mysql-flushed', {
            total: commands.length,
            requestDeviceSn: normalizedDeviceSn,
            commandIds: ids.map(id => String(id))
        });
        return response;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (rollbackError) {
            logStore.warn('adms.command.mysql-dispatch.rollback-error', {
                requestDeviceSn: normalizedDeviceSn,
                error: rollbackError.message
            });
        }
        throw error;
    } finally {
        connection.release();
    }
}

function flushPendingCommands(deviceSn = '') {
    const now = new Date();
    const queue = readAdmsCommandQueue();
    const commandsToSend = [];
    const normalizedDeviceSn = String(deviceSn || '').trim() || DEFAULT_TARGET_DEVICE_SN;
    const updatedQueue = queue.map(entry => {
        if (resolveQueueEntryTargetDeviceSn(entry) !== normalizedDeviceSn) {
            return entry;
        }

        if (entry.status === 'queued' || entry.status === 'retry_pending') {
            commandsToSend.push(entry);
            return {
                ...entry,
                status: 'sent_waiting_ack',
                sentAt: now.toISOString(),
                requestDeviceSn: normalizedDeviceSn
            };
        }

        if (entry.status === 'sent_waiting_ack') {
            const sentAt = entry.sentAt ? new Date(entry.sentAt) : null;
            if (!sentAt || now - sentAt > 60000) {
                commandsToSend.push(entry);
                return {
                    ...entry,
                    sentAt: now.toISOString(),
                    requestDeviceSn: normalizedDeviceSn
                };
            }
        }

        return entry;
    });

    if (commandsToSend.length === 0) {
        refreshPendingCommandsMemory();
        return 'OK';
    }

    saveAdmsCommandQueue(updatedQueue);
    refreshPendingCommandsMemory();

    const response = commandsToSend.map(entry => entry.command).join('\r\n');
    logSentAdmsCommands(commandsToSend, normalizedDeviceSn);
    logStore.info('adms.commands.flushed', {
        total: commandsToSend.length,
        requestDeviceSn: normalizedDeviceSn
    });
    return response;
}

function logSentAdmsCommands(entries, requestDeviceSn = '') {
    const timestamp = new Date().toISOString();

    for (const entry of entries) {
        const summary = summarizeAdmsCommand(entry.command, entry, requestDeviceSn);
        fs.appendFileSync(admsCommandSentLogPath, `${JSON.stringify({
            timestamp,
            ...summary
        })}\n`);
        if (summary.commandId) {
            admsCommandMetadataById.delete(String(summary.commandId));
        }
    }
}

function summarizeAdmsCommand(command, entry = null, requestDeviceSn = '') {
    const commandText = String(command || '');
    const commandIdMatch = commandText.match(/^C:(\d+):/);
    const commandId = commandIdMatch ? commandIdMatch[1] : '';
    const metadata = admsCommandMetadataById.get(String(commandId)) || {};
    const hasContent = /(?:^|\t)Content=/.test(commandText);
    const contentMatch = commandText.match(/(?:^|\t)Content=([^\t]+)/);
    const contentValue = contentMatch ? contentMatch[1] : '';
    const hasTrailingCommaAfterContent = Boolean(contentValue && contentValue.endsWith(','));
    const contentLength = contentValue ? contentValue.length : 0;
    const sizeMatch = commandText.match(/\bSize=(\d+)\b/i);
    const pinMatch = commandText.match(/\bPIN=(\d+)\b/i) || commandText.match(/\bPin=(\d+)\b/);
    const commandType = commandText.includes('USERINFO')
        ? 'USERINFO'
        : commandText.includes('BIOPHOTO')
            ? 'BIOPHOTO'
            : commandText.includes('BIODATA')
                ? 'BIODATA'
                : 'OTHER';

    return {
        commandId,
        commandType: entry?.commandType || commandType,
        pin: entry?.pin || (pinMatch ? pinMatch[1] : ''),
        targetDeviceSn: resolveQueueEntryTargetDeviceSn(entry),
        requestDeviceSn: String(requestDeviceSn || '').trim() || null,
        siteId: entry?.siteId || DEFAULT_SITE_ID,
        deviceName: entry?.deviceName || '',
        locationName: entry?.locationName || '',
        imageMode: metadata.imageMode || '',
        contentTerminator: metadata.contentTerminator || '',
        size: sizeMatch ? sizeMatch[1] : '',
        hasContent,
        contentLength,
        hasTrailingCommaAfterContent,
        commandPreview: buildAdmsCommandPreview(commandText)
    };
}

function buildAdmsCommandPreview(commandText) {
    if (!/(?:^|\t)Content=/.test(commandText)) {
        return commandText;
    }

    return commandText.replace(/((?:^|\t)Content=)([^\t]+)/, (_match, prefix, value) => {
        const suffix = value.endsWith(',') ? ',' : '';
        return `${prefix}[base64:${value.length}]${suffix}`;
    });
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizePin(value) {
    const raw = String(value || '').trim();
    return /^\d{1,20}$/.test(raw) ? raw : '';
}

function normalizeNuip(value) {
    const raw = String(value || '').trim();
    return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : '';
}

function normalizeUid(value) {
    return normalizePin(value);
}

function normalizeUserId(value) {
    const raw = String(value || '').trim();
    return /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : '';
}

function normalizeName(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 64) {
        return '';
    }

    const sanitized = raw.replace(/[^\p{L}\p{N}\s._-]/gu, '').trim();
    return sanitized.length >= 2 ? sanitized : '';
}

function normalizeAdmsCommandName(value) {
    const asciiName = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const cleaned = asciiName
        .replace(/[^A-Za-z0-9 _-]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 24);

    return cleaned.length >= 2 ? cleaned : '';
}

function parseAdmsDevicecmdResult(req) {
    const rawBody = getRawIclockBody(req);
    const bodyFields = parseAdmsFieldMap(rawBody);
    const queryFields = normalizeFieldMap(req.query);

    return {
        sn: firstNonEmpty(bodyFields.SN, queryFields.SN),
        id: firstNonEmpty(bodyFields.ID, queryFields.ID),
        returnValue: firstNonEmpty(bodyFields.Return, queryFields.Return),
        cmd: firstNonEmpty(bodyFields.CMD, queryFields.CMD),
        rawBody
    };
}

function parseAdmsDevicecmdResults(req) {
    const rawBody = getRawIclockBody(req);
    const queryFields = normalizeFieldMap(req.query);
    const bodyLines = String(rawBody || '')
        .split(/\r?\n/)
        .map(line => String(line || '').trim())
        .filter(Boolean);

    const results = bodyLines
        .map(line => {
            const bodyFields = parseAdmsFieldMap(line);
            const id = firstNonEmpty(bodyFields.ID, queryFields.ID);
            const returnValue = firstNonEmpty(bodyFields.Return, queryFields.Return);
            const cmd = firstNonEmpty(bodyFields.CMD, queryFields.CMD);

            if (!id && !returnValue && !cmd) {
                return null;
            }

            return {
                sn: firstNonEmpty(bodyFields.SN, queryFields.SN),
                id,
                returnValue,
                cmd,
                rawLine: line,
                rawBody
            };
        })
        .filter(Boolean);

    if (results.length > 0) {
        return results;
    }

    const fallback = parseAdmsDevicecmdResult(req);
    if (!fallback.id && !fallback.returnValue && !fallback.cmd) {
        return [];
    }

    return [{
        ...fallback,
        rawLine: String(fallback.rawBody || '').trim()
    }];
}

function parseAdmsFieldMap(text) {
    const params = new URLSearchParams(String(text || '').trim());
    const values = {};

    for (const [key, value] of params.entries()) {
        values[key] = value;
    }

    return values;
}

function normalizeFieldMap(value) {
    const entries = Object.entries(value || {});
    const normalized = {};

    for (const [key, raw] of entries) {
        normalized[key] = Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
    }

    return normalized;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value !== '') {
            return value;
        }
    }

    return '';
}

function normalizePassword(value) {
    if (value === undefined || value === null || value === '') {
        return '';
    }

    const raw = String(value);
    return /^[\x21-\x7E]{1,16}$/.test(raw) ? raw : null;
}

async function handleZkEndpoint(req, res, endpoint, action, failureStatus = 502) {
    const startedAt = process.hrtime.bigint();
    const ip = String((req.method === 'GET' ? req.query.ip : req.body.ip) || config.zk.ip || '').trim() || null;

    try {
        const result = await action();
        const durationMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
        logStore.info('zk.endpoint.result', {
            endpoint,
            ip,
            durationMs,
            result: result.ok === false ? 'error' : 'success'
        });
        res.status(result.ok === false ? failureStatus : 200).json(result);
    } catch (error) {
        const durationMs = Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
        logStore.warn('zk.endpoint.result', {
            endpoint,
            ip,
            durationMs,
            result: 'error',
            code: error.code || null
        });
        res.status(error.statusCode || failureStatus).json({
            ok: false,
            endpoint,
            ip,
            durationMs,
            error: error.message || 'Error de comunicacion con ZKTeco',
            code: error.code || 'ZK_ENDPOINT_FAILED'
        });
    }
}

function traducirMetodo(codigo) {
    const metodos = {
        '0': 'Huella',
        '1': 'Huella',
        '2': 'Tarjeta',
        '15': 'Reconocimiento Facial'
    };
    return metodos[codigo] || 'Desconocido';
}

function procesarRegistros(body) {
    if (!body || typeof body !== 'string') {
        return [];
    }

    return body
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /^\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\d+/.test(linea))
        .map(linea => {
            const match = linea.match(/^(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)(?:\s+(\d+))?(?:\s+([^\s]+))?/);
            if (!match) {
                return null;
            }

            return {
                pin: match[1],
                fecha: `${match[2]} ${match[3]}`,
                timestamp: `${match[2]} ${match[3]}`,
                metodo: match[4],
                metodoTexto: traducirMetodo(match[4]),
                verifyStatus: match[4],
                verifyMode: match[5] || '',
                workCode: match[6] || '',
                rawLine: linea
            };
        })
        .filter(Boolean);
}

async function persistirAttlog(registros, req) {
    if (!Array.isArray(registros) || registros.length === 0) {
        return [];
    }

    const sn = String(req.query.SN || req.query.sn || '').trim();
    const mysqlDevice = sn ? await readMysqlDeviceBySerial(sn) : null;
    const dispositivoId = normalizePositiveIntegerId(mysqlDevice?.id);
    const entidadId = normalizePositiveIntegerId(mysqlDevice?.entidad_id);
    const receivedAt = new Date().toISOString();
    const persistedEntries = [];

    for (const registro of registros) {
        const entry = {
            nuip: normalizeNuip(registro.pin) || registro.pin,
            pin: registro.pin,
            timestamp: registro.timestamp,
            verifyStatus: registro.verifyStatus,
            verifyMode: registro.verifyMode,
            workCode: registro.workCode,
            rawLine: registro.rawLine,
            sn,
            entidad_id: entidadId || null,
            dispositivo_id: dispositivoId || null,
            deviceSerial: sn || null,
            deviceName: mysqlDevice?.nombre || DEFAULT_DEVICE_NAME,
            receivedAt
        };

        appendJsonLine(admsAttlogLogPath, entry);
        persistedEntries.push(entry);

        if (entidadId && dispositivoId && await mysqlTableExists('asistencias')) {
            await db.query(`
                INSERT INTO asistencias (entidad_id, dispositivo_id, nuip, timestamp, raw_line)
                VALUES (?, ?, ?, ?, ?)
            `, [entidadId, dispositivoId, entry.nuip, entry.timestamp, entry.rawLine || null]);
        } else if (!dispositivoId) {
            logStore.warn('attendance.mysql.device-not-found', {
                sn,
                rawLine: entry.rawLine || null
            });
        }

        if (registro.pin) {
            markAttendanceConfirmedForPin(registro.pin);
        }
    }

    return persistedEntries;
}

function encolarComando(cmd) {
    if (!comandosPendientes.includes(cmd)) {
        comandosPendientes.push(cmd);
    }
}

async function procesarMensajeUser(body) {
    if (!await mysqlTableExists('usuarios')) {
        logStore.warn('legacy.usuarios.disabled', {
            route: 'procesarMensajeUser'
        });
        return;
    }

    const pinMatch = body.match(/USER\s+PIN=(\d+)/i);
    const nameMatch = body.match(/Name=([^\r\n]+)/i);

    if (!pinMatch) {
        return;
    }

    const pin = pinMatch[1];
    const nombre = normalizeName(nameMatch ? nameMatch[1].trim() : `Usuario_${pin}`) || `Usuario_${pin}`;

    await db.query(
        `INSERT INTO usuarios (pin, nombre) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE nombre = VALUES(nombre)`,
        [pin, nombre]
    );

    logStore.info('adms.user.synced', {
        pin,
        nombre
    });
}

async function procesarBiodata(body) {
    if (!await mysqlTableExists('usuarios')) {
        logStore.warn('legacy.usuarios.disabled', {
            route: 'procesarBiodata'
        });
        return;
    }

    const biodataLines = body
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /BIODATA/i.test(linea) && /Pin=\d+/i.test(linea) && /Tmp=/i.test(linea));

    for (const biodataLine of biodataLines) {
        const biodataEntry = parseBiodataLine(biodataLine);
        if (biodataEntry) {
            appendJsonLine(admsBiodataLogPath, {
                timestamp: new Date().toISOString(),
                ...biodataEntry
            });
        }
    }

    const biodataLine = biodataLines[0];

    if (!biodataLine) {
        return;
    }

    const pinMatch = biodataLine.match(/Pin=(\d+)/i);
    const tmpIndex = biodataLine.indexOf('Tmp=');

    if (!pinMatch || tmpIndex === -1) {
        logStore.warn('adms.biodata.invalid', { line: biodataLine });
        return;
    }

    const pin = pinMatch[1];
    const templateRaw = biodataLine.slice(tmpIndex + 4).trim();

    if (templateRaw.length < 20) {
        logStore.warn('adms.biodata.short-template', {
            pin,
            length: templateRaw.length
        });
        return;
    }

    const [rows] = await db.query('SELECT template FROM usuarios WHERE pin = ?', [pin]);

    if (rows.length === 0) {
        await db.query(
            `INSERT INTO usuarios (pin, nombre, template, estado)
             VALUES (?, ?, ?, 'activo')`,
            [pin, `Usuario_${pin}`, templateRaw]
        );

        logStore.info('adms.biodata.user-created', {
            pin,
            templateLength: templateRaw.length
        });
        return;
    }

    if (rows[0].template) {
        logStore.warn('adms.biodata.skipped-existing-template', { pin });
        return;
    }

    await db.query(
        `UPDATE usuarios SET template = ?, estado = 'activo' WHERE pin = ?`,
        [templateRaw, pin]
    );

    logStore.info('adms.biodata.saved', {
        pin,
        templateLength: templateRaw.length
    });
}

async function procesarBiophotos(body) {
    const biophotoLines = body
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /BIOPHOTO/i.test(linea) && /PIN=\d+/i.test(linea) && /Content=/i.test(linea));

    for (const biophotoLine of biophotoLines) {
        const biophotoEntry = parseBiophotoLine(biophotoLine);
        if (!biophotoEntry) {
            continue;
        }

        const fileName = `${biophotoEntry.pin}-${biophotoEntry.type}-${biophotoEntry.index}.jpg`;
        const filePath = path.join(biophotosDir, fileName);

        fs.writeFileSync(filePath, Buffer.from(biophotoEntry.content, 'base64'));

        appendJsonLine(admsBiophotoLogPath, {
            timestamp: new Date().toISOString(),
            pin: biophotoEntry.pin,
            no: biophotoEntry.no,
            index: biophotoEntry.index,
            fileName: biophotoEntry.fileName,
            type: biophotoEntry.type,
            size: biophotoEntry.size,
            savedAs: fileName
        });
    }
}

function parseBiodataLine(line) {
    if (!line) {
        return null;
    }

    const tmpIndex = line.indexOf('Tmp=');
    if (tmpIndex === -1) {
        return null;
    }

    const metadata = line.slice(0, tmpIndex).trim();
    const tmp = line.slice(tmpIndex + 4).trim();

    return {
        pin: extractField(metadata, 'Pin'),
        no: extractField(metadata, 'No'),
        index: extractField(metadata, 'Index'),
        valid: extractField(metadata, 'Valid'),
        duress: extractField(metadata, 'Duress'),
        type: extractField(metadata, 'Type'),
        majorVer: extractField(metadata, 'MajorVer'),
        minorVer: extractField(metadata, 'MinorVer'),
        format: extractField(metadata, 'Format'),
        tmp
    };
}

function parseBiophotoLine(line) {
    if (!line) {
        return null;
    }

    const contentIndex = line.indexOf('Content=');
    if (contentIndex === -1) {
        return null;
    }

    const metadata = line.slice(0, contentIndex).trim();
    const content = line.slice(contentIndex + 8).trim();

    return {
        pin: extractField(metadata, 'PIN'),
        no: extractField(metadata, 'No'),
        index: extractField(metadata, 'Index'),
        fileName: extractField(metadata, 'FileName'),
        type: extractField(metadata, 'Type'),
        size: extractField(metadata, 'Size'),
        content
    };
}

function extractField(text, fieldName) {
    const match = String(text || '').match(new RegExp(`${fieldName}=([^\\s]+)`, 'i'));
    return match ? match[1] : '';
}

// Nuevos endpoints para gestiÃ³n de registros
app.get('/adms/records/overview', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const [personasRows] = await db.query('SELECT COUNT(*) as count FROM usuarios');
    const scopedPersonPins = buildScopedPersonPins(filters);
    const asistenciasEntries = readAttendanceEntries({ sn: filters.activeSn, siteId: filters.siteId, scopeAll: filters.scopeAll, limit: 0 });
    const devices = readAdmsDevices().filter(device => matchesScopedRecord(device, filters, { snFields: ['sn'], siteIdFields: ['siteId'] }));
    const commands = buildAdmsCommandsReadModel(filters);
    const pendingItems = filterPendingSyncItems(filters);
    const biodataEntries = buildBiodataSummary(filters);
    const photos = buildPhotosSummary(filters);

    res.json({
        totalPersonas: filters.scopeAll ? personasRows[0].count : scopedPersonPins.size,
        totalAsistencias: asistenciasEntries.length,
        totalDispositivos: devices.length,
        totalComandos: commands.length,
        totalPendientes: pendingItems.pendingCommands.length,
        totalBiodata: biodataEntries.length,
        totalFotos: photos.length,
        scopeApplied: filters.scopeAll ? 'all' : 'device'
    });
}));

app.get('/adms/records/persons', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const scopedPersonPins = buildScopedPersonPins(filters);
    const applyPersonScope = persons => {
        if (filters.scopeAll) {
            return { records: persons, legacyUnassignedCount: 0, message: '' };
        }

        const records = persons.filter(person => scopedPersonPins.has(String(person.pin || '')));
        const legacyUnassignedCount = Math.max(0, persons.length - records.length);
        return {
            records,
            legacyUnassignedCount,
            message: legacyUnassignedCount > 0
                ? 'Personas legacy sin dispositivo asignado. Use Ver todos para revisarlas.'
                : ''
        };
    };

    // Intentar desde MySQL primero
    try {
        const [mysqlPersons] = await db.query(`
            SELECT pin, nombre as name, foto as photo, 
                   LENGTH(template) > 0 as hasBiodata,
                   estado as status,
                   created_at as createdAt, 
                   updated_at as updatedAt
            FROM usuarios
        `);

        const admsPersons = readLatestAdmsPersons();
        const attendanceEntries = readAttendanceEntries();
        const attendanceByPin = new Set(attendanceEntries.map(entry => String(entry.pin)));

        const enrichedPersons = mysqlPersons.map(person => {
            const admsData = admsPersons.find(adms => adms.pin === person.pin);
            const photoInfo = resolvePersonPhotoInfo(person.pin, person.photo || admsData?.photo || '');
            const deviceSyncStatus = admsData?.deviceSyncStatus || computeDeviceSyncStatusForPin(person.pin);
            const hasAttendance = attendanceByPin.has(String(person.pin));
            return {
                pin: person.pin,
                name: person.name,
                photo: person.photo,
                photoDbValue: photoInfo.photoDbValue,
                photoFileExists: photoInfo.photoFileExists,
                photoResolvedPath: photoInfo.photoResolvedPath,
                imageSize: admsData?.imageSize || null,
                userCommandId: admsData?.userCommandId || null,
                biophotoCommandId: admsData?.biophotoCommandId || null,
                biodataCommandId: admsData?.biodataCommandId || null,
                hasAttendance,
                attendanceConfirmed: hasAttendance,
                hasPhoto: photoInfo.hasPhoto,
                hasBiodata: toBooleanFlag(person.hasBiodata),
                status: person.status,
                deviceSyncStatus,
                createdAt: person.createdAt,
                updatedAt: person.updatedAt
            };
        });

        const scoped = applyPersonScope(enrichedPersons);
        res.json({
            ...scoped,
            scopeApplied: filters.scopeAll ? 'all' : 'device'
        });
    } catch (error) {
        // Fallback a data/adms/adms-persons.jsonl
        console.warn('MySQL no disponible, usando respaldo ADMS:', error.message);
        const admsPersons = readLatestAdmsPersons();
        const attendanceEntries = readAttendanceEntries();
        const attendanceByPin = new Set(attendanceEntries.map(entry => String(entry.pin)));

        const enrichedPersons = admsPersons.map(person => {
            const photoInfo = resolvePersonPhotoInfo(person.pin, person.photo || '');
            const hasAttendance = attendanceByPin.has(String(person.pin));
            return {
                pin: person.pin,
                name: person.name,
                photo: person.photo,
                photoDbValue: photoInfo.photoDbValue,
                photoFileExists: photoInfo.photoFileExists,
                photoResolvedPath: photoInfo.photoResolvedPath,
                imageSize: person.imageSize,
                userCommandId: person.userCommandId,
                biophotoCommandId: person.biophotoCommandId,
                biodataCommandId: person.biodataCommandId,
                hasAttendance,
                attendanceConfirmed: hasAttendance,
                hasPhoto: photoInfo.hasPhoto,
                hasBiodata: false,
                status: person.status || 'activo',
                deviceSyncStatus: person.deviceSyncStatus || computeDeviceSyncStatusForPin(person.pin),
                createdAt: person.createdAt,
                updatedAt: person.updatedAt
            };
        });
        const scoped = applyPersonScope(enrichedPersons);
        res.json({
            ...scoped,
            scopeApplied: filters.scopeAll ? 'all' : 'device'
        });
    }
}));

app.get('/adms/records/attendance', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const pin = normalizePin(req.query.pin);
    const from = normalizeDateFilter(req.query.from);
    const to = normalizeDateFilter(req.query.to);
    const limit = parseInt(req.query.limit, 10) || 100;

    const entries = readAttendanceEntries({
        pin,
        from,
        to,
        limit,
        sn: filters.activeSn,
        siteId: filters.siteId,
        scopeAll: filters.scopeAll
    });
    res.json(entries);
}));

app.get('/adms/records/commands', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const pin = normalizePin(req.query.pin);
    const commandId = req.query.commandId;
    const commandType = req.query.commandType;
    const status = req.query.status;
    const commands = buildAdmsCommandsReadModel(filters, { pin, commandId, commandType, status });
    res.json(commands.slice(0, 100)); // Limitar a 100
}));

app.get('/adms/sync/status', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.query.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin valido' });
    }

    const [rows] = await db.query('SELECT COUNT(*) as count FROM usuarios WHERE pin = ?', [pin]);
    const personExistsInDb = rows[0].count > 0;
    const localPerson = readLatestAdmsPersonByPin(pin);
    const queueCommands = readAdmsCommandQueue().filter(entry => String(entry.pin) === String(pin));
    const attendanceConfirmed = readAttendanceEntries({ pin }).length > 0;
    const deviceSyncStatus = localPerson ? computeDeviceSyncStatusForPin(pin) : 'unknown';

    res.json({
        pin,
        personExistsInDb,
        personExistsLocal: Boolean(localPerson),
        deviceSyncStatus,
        attendanceConfirmed,
        commands: queueCommands.map(entry => ({
            commandType: entry.commandType,
            status: entry.status,
            createdAt: entry.createdAt,
            sentAt: entry.sentAt,
            acknowledgedAt: entry.acknowledgedAt,
            returnCode: entry.returnCode
        }))
    });
}));

app.get('/adms/sync/pending', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const pendingItems = filterPendingSyncItems(filters);
    res.json(pendingItems);
}));

app.post('/adms/sync/retry', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const pending = retryPendingAdmsCommands(pin);
    res.json({ ok: true, retryCount: pending.length, pending });
}));

app.get('/adms/records/biodata', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    res.json(buildBiodataSummary(filters));
}));

app.get('/adms/records/photos', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    res.json(buildPhotosSummary(filters));
}));

app.post('/adms/records/delete-preview', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const scope = req.body.scope || 'local';
    const scopeText = String(scope || '').toLowerCase();
    const isLocalScope = scopeText.includes('local');
    const isDeviceScope = scopeText.includes('device');
    const deleteAttendance = req.body.deleteAttendance || false;
    const deletePhoto = req.body.deletePhoto || false;
    const deleteBiodata = req.body.deleteBiodata || false;

    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN requerido' });
    }

    if (isDeviceScope) {
        validateExplicitSiteDeviceAccess(req.body.siteId, req.body.targetDeviceSn);
    }

    const preview = {
        pin,
        scope,
        deleteAttendance,
        deletePhoto,
        deleteBiodata,
        personaEncontrada: null,
        asistenciasEncontradas: [],
        fotoEncontrada: null,
        fotoRegistradaEnBd: false,
        fotoDbValue: null,
        fotoResolvedPath: null,
        fotoExisteFisicamente: false,
        biodataEncontrada: null,
        comandosRelacionados: [],
        queSeBorrara: [],
        queNoSeBorrara: [],
        advertencias: []
    };

    // Buscar persona
    try {
        const [personRows] = await db.query('SELECT * FROM usuarios WHERE pin = ?', [pin]);
        if (personRows.length > 0) {
            preview.personaEncontrada = personRows[0];
        }
    } catch (error) {
        preview.advertencias.push('MySQL no disponible para verificar persona');
    }

    // Buscar asistencias
    if (deleteAttendance) {
        try {
            const [attendanceRows] = await db.query('SELECT COUNT(*) as count FROM asistencias WHERE pin = ?', [pin]);
            preview.asistenciasEncontradas = { count: attendanceRows[0].count };
            if (attendanceRows[0].count > 0) {
                preview.queSeBorrara.push(`${attendanceRows[0].count} registros de asistencia`);
            }
        } catch (error) {
            preview.advertencias.push('MySQL no disponible para verificar asistencias');
        }
    } else {
        preview.queNoSeBorrara.push('Asistencias (no solicitadas para borrado)');
    }

    const photoDbValue = preview.personaEncontrada?.foto ||
        preview.personaEncontrada?.photo ||
        readLatestAdmsPersonByPin(pin)?.photo ||
        '';
    const photoInfo = resolvePersonPhotoInfo(pin, photoDbValue);
    preview.fotoRegistradaEnBd = photoInfo.fotoRegistradaEnBd;
    preview.fotoDbValue = photoInfo.fotoDbValue;
    preview.fotoResolvedPath = photoInfo.fotoResolvedPath;
    preview.fotoExisteFisicamente = photoInfo.fotoExisteFisicamente;

    if (photoInfo.fotoExisteFisicamente && photoInfo.fotoResolvedPath) {
        const stats = fs.statSync(photoInfo.fotoResolvedPath);
        preview.fotoEncontrada = { size: stats.size, path: photoInfo.fotoResolvedPath };
    }

    if (preview.fotoRegistradaEnBd && !preview.fotoExisteFisicamente) {
        preview.advertencias.push('La persona tiene referencia de foto en BD, pero el archivo fÃ­sico no fue encontrado.');
    }

    if (deletePhoto) {
        if (preview.fotoExisteFisicamente) {
            preview.queSeBorrara.push('Foto del usuario');
        }
    } else {
        preview.queNoSeBorrara.push('Foto (no solicitada para borrado)');
    }

    // Buscar biodata
    if (deleteBiodata) {
        const biodataEntries = readJsonLinesFile(admsBiodataLogPath);
        const biodata = biodataEntries.filter(entry => entry.pin === pin);
        if (biodata.length > 0) {
            preview.biodataEncontrada = { count: biodata.length };
            preview.queSeBorrara.push(`${biodata.length} entradas BIODATA`);
        }
    } else {
        preview.queNoSeBorrara.push('BIODATA (no solicitada para borrado)');
    }

    // Buscar comandos relacionados
    const sentCommands = readJsonLinesFile(admsCommandSentLogPath);
    const relatedCommands = sentCommands.filter(cmd => cmd.pin === pin);
    preview.comandosRelacionados = relatedCommands.map(cmd => ({
        commandId: cmd.commandId,
        command: cmd.command,
        timestamp: cmd.timestamp
    }));

    const personStatus = String(preview.personaEncontrada?.estado || preview.personaEncontrada?.status || '').trim().toLowerCase();

    if (isLocalScope) {
        if (personStatus === 'eliminado') {
            preview.advertencias.push('La persona ya estÃ¡ marcada como eliminada. No se requiere baja lÃ³gica adicional.');
            preview.queNoSeBorrara.push('Baja lÃ³gica de persona en el sistema local (ya estaba eliminada)');
        } else if (preview.personaEncontrada) {
            preview.queSeBorrara.push('Baja lÃ³gica de persona en el sistema local');
        }
    }

    if (isDeviceScope) {
        preview.queSeBorrara.push('Se enviarÃ¡ comando de borrado al dispositivo fÃ­sico');
        preview.advertencias.push('Si el dispositivo estÃ¡ offline, el comando quedarÃ¡ en cola hasta la prÃ³xima conexiÃ³n.');
        preview.advertencias.push('La eliminaciÃ³n fÃ­sica solo se confirma cuando el dispositivo responda Return=0.');
    }

    res.json({ ok: true, preview });
}));

async function performDeletePersonOperation(payload = {}) {
    const pin = normalizePin(payload.pin);
    const scope = payload.scope || 'local';
    const scopeText = String(scope || '').toLowerCase();
    const isLocalScope = scopeText.includes('local');
    const isDeviceScope = scopeText.includes('device');
    const deleteAttendance = payload.deleteAttendance || false;
    const deletePhoto = payload.deletePhoto || false;
    const deleteBiodata = payload.deleteBiodata || false;
    const reason = payload.reason || '';
    const confirmation = payload.confirmation || '';

    if (!pin) {
        const error = new Error('PIN requerido');
        error.statusCode = 400;
        throw error;
    }

    const expectedConfirmation = `BORRAR PIN ${pin}`;
    if (confirmation !== expectedConfirmation) {
        const error = new Error('Confirmacion incorrecta');
        error.statusCode = 400;
        throw error;
    }

    if (isDeviceScope) {
        validateExplicitSiteDeviceAccess(payload.siteId, payload.targetDeviceSn);
    }

    const auditEntry = {
        timestamp: new Date().toISOString(),
        pin,
        scope,
        deleteAttendance,
        deletePhoto,
        deleteBiodata,
        reason,
        actions: [],
        status: 'in_progress',
        deviceDeleteRequested: isDeviceScope,
        deviceDeleteCommandId: null,
        deviceDeleteCommand: null,
        deviceDeleteStatus: null,
        deviceDeleteReturnCode: null,
        deviceDeleteAcknowledgedAt: null
    };

    if (isLocalScope) {
        try {
            if (deleteAttendance) {
                const [result] = await db.query('DELETE FROM asistencias WHERE pin = ?', [pin]);
                auditEntry.actions.push(`Borradas ${result.affectedRows} asistencias`);
            }

            if (deletePhoto) {
                const photoPath = path.join(facesUploadsDir, `${pin}.jpg`);
                if (fs.existsSync(photoPath)) {
                    fs.unlinkSync(photoPath);
                    auditEntry.actions.push('Foto borrada');
                }
            }

            await db.query('UPDATE usuarios SET estado = ? WHERE pin = ?', ['eliminado', pin]);
            auditEntry.actions.push('Usuario marcado como eliminado en MySQL');

            auditEntry.status = 'completed_local';
        } catch (error) {
            auditEntry.status = 'failed_mysql';
            auditEntry.error = error.message;
            appendJsonLine(path.join(dataDir, 'adms', 'pending-delete-db.jsonl'), {
                pin,
                scope,
                deleteAttendance,
                deletePhoto,
                deleteBiodata,
                reason,
                timestamp: auditEntry.timestamp
            });
        }
    }

    if (isDeviceScope) {
        const targetContext = resolveCommandTargetMetadata(payload);
        const deleteCommandId = allocateAdmsCommandId();
        const deleteCommand = `C:${deleteCommandId}:DATA DELETE USERINFO PIN=${pin}`;
        const queueEntry = enqueueAdmsCommandEntry({
            commandId: deleteCommandId,
            commandType: 'DELETE_USERINFO',
            pin,
            command: deleteCommand,
            purpose: 'delete-person',
            ...targetContext
        });

        auditEntry.deviceDeleteCommandId = String(deleteCommandId);
        auditEntry.deviceDeleteCommand = deleteCommand;
        auditEntry.deviceDeleteStatus = queueEntry.status;
        auditEntry.deviceDeleteReturnCode = queueEntry.returnCode;
        auditEntry.deviceDeleteAcknowledgedAt = queueEntry.acknowledgedAt;
        auditEntry.actions.push('Comando de borrado del dispositivo encolado');
        auditEntry.status = auditEntry.status === 'failed_mysql'
            ? 'failed_mysql_device_queued'
            : 'pending_device_confirmation';
    }

    appendJsonLine(path.join(dataDir, 'adms', 'delete-audit.jsonl'), auditEntry);

    let message = auditEntry.status === 'failed_mysql'
        ? 'El borrado local fallo.'
        : 'Borrado local realizado';

    if (auditEntry.status === 'failed_mysql_device_queued') {
        message = 'El borrado local fallo. El borrado del dispositivo quedo en cola.';
    } else if (isLocalScope && isDeviceScope) {
        message = 'Borrado local realizado. Borrado del dispositivo en cola.';
    } else if (!isLocalScope && isDeviceScope) {
        message = 'Borrado enviado al dispositivo. Esperando confirmacion.';
    } else if (!isLocalScope) {
        message = 'Borrado procesado.';
    }

    return {
        ok: true,
        message,
        deviceDeleteCommandId: auditEntry.deviceDeleteCommandId,
        auditEntry
    };
}

app.post('/adms/records/delete-person', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.body.pin);
    const scope = req.body.scope || 'local';
    const scopeText = String(scope || '').toLowerCase();
    const isLocalScope = scopeText.includes('local');
    const isDeviceScope = scopeText.includes('device');
    const deleteAttendance = req.body.deleteAttendance || false;
    const deletePhoto = req.body.deletePhoto || false;
    const deleteBiodata = req.body.deleteBiodata || false;
    const reason = req.body.reason || '';
    const confirmation = req.body.confirmation || '';

    if (!pin) {
        return res.status(400).json({ ok: false, error: 'PIN requerido' });
    }

    const expectedConfirmation = `BORRAR PIN ${pin}`;
    if (confirmation !== expectedConfirmation) {
        return res.status(400).json({ ok: false, error: 'ConfirmaciÃ³n incorrecta' });
    }

    if (isDeviceScope) {
        validateExplicitSiteDeviceAccess(req.body.siteId, req.body.targetDeviceSn);
    }

    const auditEntry = {
        timestamp: new Date().toISOString(),
        pin,
        scope,
        deleteAttendance,
        deletePhoto,
        deleteBiodata,
        reason,
        actions: [],
        status: 'in_progress',
        deviceDeleteRequested: isDeviceScope,
        deviceDeleteCommandId: null,
        deviceDeleteCommand: null,
        deviceDeleteStatus: null,
        deviceDeleteReturnCode: null,
        deviceDeleteAcknowledgedAt: null
    };

    if (isLocalScope) {
        try {
            if (deleteAttendance) {
                const [result] = await db.query('DELETE FROM asistencias WHERE pin = ?', [pin]);
                auditEntry.actions.push(`Borradas ${result.affectedRows} asistencias`);
            }

            if (deletePhoto) {
                const photoPath = path.join(facesUploadsDir, `${pin}.jpg`);
                if (fs.existsSync(photoPath)) {
                    fs.unlinkSync(photoPath);
                    auditEntry.actions.push('Foto borrada');
                }
            }

            // Marcar como eliminado en MySQL (baja lÃ³gica)
            await db.query('UPDATE usuarios SET estado = ? WHERE pin = ?', ['eliminado', pin]);
            auditEntry.actions.push('Usuario marcado como eliminado en MySQL');

            auditEntry.status = 'completed_local';
        } catch (error) {
            auditEntry.status = 'failed_mysql';
            auditEntry.error = error.message;
            appendJsonLine(path.join(dataDir, 'adms', 'pending-delete-db.jsonl'), {
                pin,
                scope,
                deleteAttendance,
                deletePhoto,
                deleteBiodata,
                reason,
                timestamp: auditEntry.timestamp
            });
        }
    }

    if (isDeviceScope) {
        const targetContext = resolveCommandTargetMetadata(req.body);
        const deleteCommandId = allocateAdmsCommandId();
        const deleteCommand = `C:${deleteCommandId}:DATA DELETE USERINFO PIN=${pin}`;
        const queueEntry = enqueueAdmsCommandEntry({
            commandId: deleteCommandId,
            commandType: 'DELETE_USERINFO',
            pin,
            command: deleteCommand,
            purpose: 'delete-person',
            ...targetContext
        });

        auditEntry.deviceDeleteCommandId = String(deleteCommandId);
        auditEntry.deviceDeleteCommand = deleteCommand;
        auditEntry.deviceDeleteStatus = queueEntry.status;
        auditEntry.deviceDeleteReturnCode = queueEntry.returnCode;
        auditEntry.deviceDeleteAcknowledgedAt = queueEntry.acknowledgedAt;
        auditEntry.actions.push('Comando de borrado del dispositivo encolado');
        auditEntry.status = auditEntry.status === 'failed_mysql'
            ? 'failed_mysql_device_queued'
            : 'pending_device_confirmation';
    }

    appendJsonLine(path.join(dataDir, 'adms', 'delete-audit.jsonl'), auditEntry);

    let message = auditEntry.status === 'failed_mysql'
        ? 'El borrado local fallÃ³.'
        : 'Borrado local realizado';

    if (auditEntry.status === 'failed_mysql_device_queued') {
        message = 'El borrado local fallÃ³. El borrado del dispositivo quedÃ³ en cola.';
    } else if (isLocalScope && isDeviceScope) {
        message = 'Borrado local realizado. Borrado del dispositivo en cola.';
    } else if (!isLocalScope && isDeviceScope) {
        message = 'Borrado enviado al dispositivo. Esperando confirmaciÃ³n.';
    } else if (!isLocalScope) {
        message = 'Borrado procesado.';
    }

    res.json({
        ok: true,
        message,
        deviceDeleteCommandId: auditEntry.deviceDeleteCommandId,
        auditEntry
    });
}));

app.get('/adms/records/delete-audit', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    res.json(buildDeleteAuditReadModel(filters));
}));

app.get('/adms/config/sites', asyncHandler(async (_req, res) => {
    res.json({
        sites: readAdmsSites()
    });
}));

app.post('/adms/config/sites/:siteId', asyncHandler(async (req, res) => {
    const siteId = String(req.params.siteId || '').trim();
    const name = String(req.body.name || '').trim();
    const hostname = req.body.hostname == null || req.body.hostname === ''
        ? null
        : normalizeRequestHostname(req.body.hostname);
    const enabled = req.body.enabled !== false;

    if (!siteId || !/^[a-zA-Z0-9_-]{1,50}$/.test(siteId)) {
        return res.status(400).json({ ok: false, error: 'siteId invalido' });
    }

    if (!name) {
        return res.status(400).json({ ok: false, error: 'name es obligatorio' });
    }

    const sites = readAdmsSites();
    const siteIndex = sites.findIndex(site => String(site.siteId || '').trim() === siteId);
    const currentSite = siteIndex >= 0 ? sites[siteIndex] : null;
    const nextSite = {
        siteId,
        name,
        hostname,
        enabled,
        allowedDeviceSns: Array.isArray(currentSite?.allowedDeviceSns) ? currentSite.allowedDeviceSns : []
    };

    if (siteIndex >= 0) {
        sites[siteIndex] = {
            ...currentSite,
            ...nextSite
        };
    } else {
        sites.push(nextSite);
    }

    const updatedSites = writeAdmsSites(sites);
    res.json({
        ok: true,
        site: updatedSites.find(site => String(site.siteId || '').trim() === siteId) || nextSite,
        created: siteIndex < 0
    });
}));

app.get('/adms/config/context', asyncHandler(async (req, res) => {
    res.json(resolveSiteFromRequest(req));
}));

app.get('/adms/config/devices', asyncHandler(async (req, res) => {
    const requestedSiteId = String(req.query.siteId || '').trim();
    const sites = readAdmsSites();
    const selectedSite = requestedSiteId ? findAdmsSiteById(requestedSiteId, sites) : null;
    const allowedForSite = selectedSite && Array.isArray(selectedSite.allowedDeviceSns)
        ? new Set(selectedSite.allowedDeviceSns.map(value => String(value || '').trim()).filter(Boolean))
        : null;

    const devices = readAdmsDevices()
        .map(device => ({
        sn: device.sn,
        name: device.name || device.deviceName || '',
        deviceName: device.deviceName || device.name || '',
        siteId: device.siteId,
        locationName: device.locationName,
        enabled: device.enabled !== false,
        discoveredOnly: Boolean(device.discoveredOnly),
        estado: device.estado,
        ultima_conexion: device.ultima_conexion,
        lastSeenAt: device.lastSeenAt || null
        }))
        .filter(device => !allowedForSite || allowedForSite.has(String(device.sn || '').trim()) || device.enabled === false || device.discoveredOnly);

    res.json({ devices });
}));

app.post('/adms/config/devices/:sn', asyncHandler(async (req, res) => {
    const sn = String(req.params.sn || '').trim();
    if (!sn) {
        return res.status(400).json({ ok: false, error: 'SN invalido' });
    }

    try {
        const device = updateAdmsDeviceConfig(sn, {
            name: req.body.name,
            deviceName: req.body.deviceName,
            locationName: req.body.locationName,
            enabled: req.body.enabled,
            siteId: req.body.siteId
        });
        return res.json({ ok: true, device });
    } catch (error) {
        return res.status(400).json({ ok: false, error: error.message });
    }
}));

app.post('/adms/config/sites/:siteId/allowed-devices', asyncHandler(async (req, res) => {
    const siteId = String(req.params.siteId || '').trim();
    const sn = String(req.body.sn || '').trim();
    if (!siteId || !sn) {
        return res.status(400).json({ ok: false, error: 'Debes enviar siteId y sn validos' });
    }

    const sites = readAdmsSites();
    const siteIndex = sites.findIndex(site => String(site.siteId || '').trim() === siteId);
    if (siteIndex < 0) {
        return res.status(404).json({ ok: false, error: `La sede ${siteId} no existe` });
    }

    const currentAllowed = Array.isArray(sites[siteIndex].allowedDeviceSns) ? sites[siteIndex].allowedDeviceSns : [];
    sites[siteIndex] = {
        ...sites[siteIndex],
        allowedDeviceSns: Array.from(new Set([...currentAllowed, sn]))
    };

    const updatedSites = writeAdmsSites(sites);
    return res.json({
        ok: true,
        site: updatedSites.find(site => String(site.siteId || '').trim() === siteId) || sites[siteIndex]
    });
}));

app.delete('/adms/config/sites/:siteId/allowed-devices/:sn', asyncHandler(async (req, res) => {
    const siteId = String(req.params.siteId || '').trim();
    const sn = String(req.params.sn || '').trim();
    if (!siteId || !sn) {
        return res.status(400).json({ ok: false, error: 'Debes enviar siteId y sn validos' });
    }

    const sites = readAdmsSites();
    const siteIndex = sites.findIndex(site => String(site.siteId || '').trim() === siteId);
    if (siteIndex < 0) {
        return res.status(404).json({ ok: false, error: `La sede ${siteId} no existe` });
    }

    sites[siteIndex] = {
        ...sites[siteIndex],
        allowedDeviceSns: (Array.isArray(sites[siteIndex].allowedDeviceSns) ? sites[siteIndex].allowedDeviceSns : [])
            .filter(value => String(value || '').trim() !== sn)
    };

    const updatedSites = writeAdmsSites(sites);
    return res.json({
        ok: true,
        site: updatedSites.find(site => String(site.siteId || '').trim() === siteId) || sites[siteIndex]
    });
}));

app.use('/api/v1', requireAdminApiKey);
app.use('/api/v2', requireClientOrAdminApiKey);

app.get('/api/v1/health', asyncHandler(async (_req, res) => {
    res.json(await buildApiHealthPayload());
}));

app.get('/api/v1/sites', asyncHandler(async (_req, res) => {
    res.json({ ok: true, sites: readAdmsSites() });
}));

app.get('/api/v1/sites/:siteId', asyncHandler(async (req, res) => {
    const site = findAdmsSiteById(req.params.siteId);
    if (!site) {
        return res.status(404).json({ ok: false, error: 'Sede no encontrada' });
    }

    res.json({ ok: true, site });
}));

app.post('/api/v1/sites', asyncHandler(async (req, res) => {
    const { created, site } = upsertAdmsSiteRecord(req.body.siteId, req.body);
    res.status(created ? 201 : 200).json({ ok: true, created, site });
}));

app.patch('/api/v1/sites/:siteId', asyncHandler(async (req, res) => {
    const { site } = upsertAdmsSiteRecord(req.params.siteId, req.body, { requireExisting: true });
    res.json({ ok: true, site });
}));

app.get('/api/v1/devices', asyncHandler(async (req, res) => {
    const scopeAll = String(req.query.scope || '').trim().toLowerCase() === 'all';
    const devices = buildApiDevicesReadModel({
        siteId: req.query.siteId,
        scopeAll
    });
    res.json({
        ok: true,
        devices,
        scopeApplied: scopeAll ? 'all' : (req.query.siteId ? 'site' : 'default')
    });
}));

app.get('/api/v1/devices/:sn', asyncHandler(async (req, res) => {
    const device = getAdmsDeviceBySn(req.params.sn);
    if (!device) {
        return res.status(404).json({ ok: false, error: 'Dispositivo no encontrado' });
    }

    res.json({ ok: true, device });
}));

app.patch('/api/v1/devices/:sn', asyncHandler(async (req, res) => {
    try {
        const device = updateAdmsDeviceConfig(req.params.sn, {
            name: req.body.name,
            deviceName: req.body.deviceName,
            locationName: req.body.locationName,
            siteId: req.body.siteId,
            enabled: req.body.enabled
        });
        res.json({ ok: true, device });
    } catch (error) {
        res.status(error.statusCode || 400).json({ ok: false, error: error.message });
    }
}));

app.post('/api/v1/sites/:siteId/devices/:sn/authorize', asyncHandler(async (req, res) => {
    const result = authorizeDeviceForSite(req.params.siteId, req.params.sn);
    res.json({ ok: true, ...result });
}));

app.delete('/api/v1/sites/:siteId/devices/:sn/authorize', asyncHandler(async (req, res) => {
    const result = deauthorizeDeviceForSite(req.params.siteId, req.params.sn);
    res.json({ ok: true, ...result });
}));

app.get('/api/v1/persons', asyncHandler(async (req, res) => {
    if (requestLooksLikeMysqlPersonsList(req)) {
        const persons = await listMysqlPersons({
            nuip: req.query.nuip,
            entidad_id: req.query.entidad_id,
            estado: req.query.estado
        });
        return res.json({
            ok: true,
            persons: persons.map(toPublicPerson)
        });
    }

    const filters = getRecordsScopeFilters(req);
    const result = await buildPersonsReadModel(filters, {
        pin: req.query.pin,
        status: req.query.status
    });
    res.json({
        ok: true,
        persons: result.records,
        legacyUnassignedCount: result.legacyUnassignedCount,
        message: result.message,
        scopeApplied: filters.scopeAll ? 'all' : 'device'
    });
}));

app.post('/api/v1/persons', upload.single('image'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const normalizedNuip = normalizeNuip(body.nuip);
    const requestsDeviceSync =
        toBooleanFlag(body.syncDevice) ||
        req.file != null ||
        body.password !== undefined ||
        body.targetDeviceSn !== undefined;
    const existingPerson = normalizedNuip ? await readMysqlPersonByNuip(normalizedNuip) : null;

    if (existingPerson && existingPerson.estado === 'activo') {
        return res.status(409).json({
            ok: false,
            message: 'Ya existe una persona activa con este NUIP',
            code: 'PERSON_ALREADY_EXISTS'
        });
    }

    if (existingPerson && existingPerson.estado === 'inactivo') {
        const reactivationPayload = {
            ...(await buildMysqlPersonPayloadFromPublicBody(body, { requireName: false })),
            estado: 'activo'
        };
        const reactivatedPerson = await updateMysqlPersonByNuip(existingPerson.nuip, reactivationPayload);

        if (!requestsDeviceSync) {
            return res.status(200).json({
                ok: true,
                message: 'Persona reactivada correctamente',
                person: toPublicPerson(reactivatedPerson),
                deviceSync: {
                    requested: false
                }
            });
        }

        const syncBody = { ...body };
        if (body.targetDeviceSn !== undefined) {
            syncBody.pin_dispositivo = normalizedNuip;
            if (syncBody.name === undefined) {
                syncBody.name = reactivatedPerson.nombre_completo || reactivatedPerson.nombres;
            }
        }

        const result = await performMysqlPersonPatchWithOptionalDeviceSync({
            nuip: reactivatedPerson.nuip,
            body: syncBody,
            file: req.file || null
        });
        const publicCommands = result.deviceSync?.commands
            ? result.deviceSync.commands.map(toPublicCommand)
            : [];

        return res.status(200).json({
            ok: true,
            message: 'Persona reactivada correctamente',
            person: toPublicPerson(result.person || reactivatedPerson),
            deviceSync: {
                requested: result.deviceSync?.requested || false,
                commands: publicCommands
            }
        });
    }

    const personPayload = {
        nuip: normalizedNuip,
        ...(await buildMysqlPersonPayloadFromPublicBody(body, { requireName: true }))
    };
    const person = await createMysqlPerson(personPayload);

    if (!requestsDeviceSync) {
        return res.status(201).json({
            ok: true,
            message: 'Persona creada correctamente',
            person: toPublicPerson(person),
            deviceSync: {
                requested: false,
                commands: []
            }
        });
    }

    const result = await performMysqlPersonPatchWithOptionalDeviceSync({
        nuip: person.nuip,
        body,
        file: req.file || null
    });

    const publicCommands = result.deviceSync?.commands
        ? result.deviceSync.commands.map(toPublicCommand)
        : [];

    res.status(201).json({
        ok: true,
        message: 'Persona creada correctamente',
        person: toPublicPerson(result.person || person),
        deviceSync: {
            requested: true,
            commands: publicCommands
        }
    });
}));

app.get('/api/v1/legacy/persons/:pin', asyncHandler(async (req, res) => {
    let mysqlPerson = null;
    try {
        mysqlPerson = await readMysqlPersonByNuip(req.params.pin);
    } catch (error) {
        if (!normalizePin(req.params.pin) || String(error.statusCode || '') !== '500') {
            throw error;
        }
    }

    if (mysqlPerson) {
        return res.json({
            ok: true,
            source: 'mysql-personas',
            person: mysqlPerson
        });
    }

    const filters = getRecordsScopeFilters(req);
    const result = await buildPersonsReadModel(filters, { pin: req.params.pin });
    const person = Array.isArray(result.records) ? result.records[0] : null;
    if (!person) {
        return res.status(404).json({ ok: false, error: 'Persona no encontrada' });
    }

    res.json({ ok: true, person });
}));

app.get('/api/v1/persons/:nuip', asyncHandler(async (req, res) => {
    const nuip = String(req.params.nuip || '').trim();
    const mysqlPerson = await readMysqlPersonByNuip(nuip);
    if (!mysqlPerson) {
        return res.status(404).json({
            ok: false,
            message: 'No se encontró una persona con el NUIP indicado',
            code: 'PERSON_NOT_FOUND'
        });
    }

    res.json({
        ok: true,
        person: toPublicPerson(mysqlPerson)
    });
}));

app.post('/api/v1/persons/enroll', upload.single('image'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const normalizedPin = normalizePin(body.pin);
    const explicitUpdateRequested =
        String(body.updateMode || '').trim().toLowerCase() === 'update' ||
        toBooleanFlag(body.allowUpdate) ||
        String(body.operation || '').trim().toLowerCase() === 'update';

    if (explicitUpdateRequested) {
        return res.status(409).json({
            ok: false,
            error: 'POST solo permite crear personas nuevas',
            message: 'Usa PATCH /api/v1/persons/:nuip para actualizar.',
            updateEndpoint: `/api/v1/persons/${normalizedPin || ':nuip'}`
        });
    }

    validateExplicitSiteDeviceAccess(body.siteId, body.targetDeviceSn);
    const targetContext = resolveCommandTargetMetadata(body);
    const existence = await buildApiPersonExistence(body.pin, targetContext.siteId, targetContext.targetDeviceSn);

    if (existence.existsLocalActive || existence.existsInDevice) {
        return res.status(409).json({
            ok: false,
            error: 'La persona ya existe en el dispositivo',
            pin: existence.pin,
            siteId: targetContext.siteId,
            targetDeviceSn: targetContext.targetDeviceSn,
            existsHistorical: existence.existsHistorical,
            existsLocal: existence.existsLocal,
            existsLocalActive: existence.existsLocalActive,
            existsInDevice: existence.existsInDevice,
            canCreate: existence.canCreate,
            confidence: existence.confidence,
            canUpdate: true,
            currentPerson: existence.currentPerson,
            message: 'Usa updateMode=update para actualizar nombre, contraseÃ±a o foto.'
        });
    }

    const result = await performSafeAdmsEnrollment({
        body,
        file: req.file
    });
    const responsePayload = {
        ...result,
        operation: 'create',
        message: 'Persona creada y encolada para enrolamiento ADMS'
    };

    logStore.info('api.v1.persons.enroll', {
        pin: responsePayload.pin,
        siteId: responsePayload.siteId,
        targetDeviceSn: responsePayload.targetDeviceSn,
        userCommandId: responsePayload.userCommandId,
        biophotoCommandId: responsePayload.biophotoCommandId,
        operation: 'create'
    });

    res.status(201).json(responsePayload);
}));

app.patch('/api/v1/persons/:nuip/device-profile', upload.single('image'), asyncHandler(async (req, res) => {
    const result = await performApiDeviceProfileUpdate({
        nuip: req.params.nuip,
        body: req.body || {},
        file: req.file || null
    });

    logStore.info('api.v1.persons.device-profile.update', {
        nuip: result.nuip,
        pinDispositivo: result.pin_dispositivo,
        updated: result.updated,
        commands: result.commands
    });

    res.status(200).json(result);
}));

app.patch('/api/v1/persons/:nuip', upload.single('image'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const existingMysqlPerson = await readMysqlPersonByNuip(req.params.nuip);
    if (!existingMysqlPerson) {
        return res.status(404).json({
            ok: false,
            message: 'No se encontró una persona con el NUIP indicado',
            code: 'PERSON_NOT_FOUND'
        });
    }

    const result = await performMysqlPersonPatchWithOptionalDeviceSync({
        nuip: req.params.nuip,
        body,
        file: req.file || null
    });

    const publicCommands = result.deviceSync?.commands
        ? result.deviceSync.commands.map(toPublicCommand)
        : [];

    return res.status(200).json({
        ok: true,
        message: 'Persona actualizada correctamente',
        person: toPublicPerson(result.person),
        deviceSync: {
            requested: result.deviceSync?.requested || false,
            commands: publicCommands
        }
    });
}));

app.delete('/api/v1/persons/:nuip', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const routeNuip = normalizeNuip(String(req.params.nuip || ''));
    const rawTargetDeviceSn = String(body.targetDeviceSn || req.query.targetDeviceSn || '').trim();
    const rawSiteId = String(body.siteId || req.query.siteId || '').trim();
    const targetDeviceSn = normalizeRecordsScopeValue(rawTargetDeviceSn);
    const siteId = normalizeRecordsScopeValue(rawSiteId);

    if (!routeNuip) {
        return res.status(400).json({
            ok: false,
            message: 'NUIP requerido',
            code: 'VALIDATION_ERROR'
        });
    }

    const person = await readMysqlPersonByNuip(routeNuip);
    if (!person) {
        return res.status(404).json({
            ok: false,
            message: 'No se encontró una persona con el NUIP indicado',
            code: 'PERSON_NOT_FOUND'
        });
    }

    if (person.estado === 'inactivo') {
        return res.status(200).json({
            ok: true,
            message: 'La persona ya estaba inactiva',
            person: toPublicPerson(person),
            commandId: null,
            deviceSync: {
                requested: false,
                targetDeviceSn: null,
                pin_dispositivo: null,
                commandId: null
            }
        });
    }

    const updatedPerson = await deactivateMysqlPersonByNuip(routeNuip);
    let deviceSync = {
        requested: false,
        targetDeviceSn: null,
        pin_dispositivo: null,
        commandId: null
    };

    if (targetDeviceSn) {
        validateExplicitSiteDeviceAccess(siteId, targetDeviceSn);

        const deviceProfiles = Array.isArray(person.persona_dispositivos) ? person.persona_dispositivos : [];
        const normalizedTargetDeviceSn = String(targetDeviceSn || '').trim().toLowerCase();
        const relation = deviceProfiles.find(entry => {
            const entrySn = String(entry.numero_serie || '').trim().toLowerCase();
            const entryDeviceId = normalizePositiveIntegerId(entry.dispositivo_id);
            const targetDeviceId = normalizePositiveIntegerId(targetDeviceSn);
            return entrySn === normalizedTargetDeviceSn || (entryDeviceId && targetDeviceId && entryDeviceId === targetDeviceId);
        });

        const pinForDevice = normalizePin(relation?.pin_dispositivo) || routeNuip;
        const targetContext = resolveCommandTargetMetadata({ targetDeviceSn, siteId });
        const deleteCommandId = allocateAdmsCommandId();
        const deleteCommand = `C:${deleteCommandId}:DATA DELETE USERINFO PIN=${pinForDevice}`;

        const queueEntry = enqueueAdmsCommandEntry({
            commandId: deleteCommandId,
            commandType: 'DELETE_USERINFO',
            pin: pinForDevice,
            command: deleteCommand,
            purpose: 'delete-person',
            ...targetContext
        });

        const mysqlDevice = await readMysqlDeviceBySerial(targetContext.targetDeviceSn);
        if (mysqlDevice?.id && updatedPerson?.id) {
            await ensureMysqlPersonDeviceRelation({
                personId: updatedPerson.id,
                deviceId: mysqlDevice.id,
                pinDispositivo: pinForDevice,
                lastCommandId: deleteCommandId,
                status: 'pending'
            });
        }

        deviceSync = {
            requested: true,
            targetDeviceSn: targetContext.targetDeviceSn,
            pin_dispositivo: pinForDevice,
            commandId: String(queueEntry.commandId || deleteCommandId)
        };
    }

    res.json({
        ok: true,
        message: 'Persona desactivada correctamente',
        person: toPublicPerson(updatedPerson),
        commandId: deviceSync.commandId,
        deviceSync
    });
}));

app.get('/api/v1/attendance', asyncHandler(async (req, res) => {
    const rawPin = String(req.query.pin || '').trim();
    const rawFrom = String(req.query.from || '').trim();
    const rawTo = String(req.query.to || '').trim();
    const rawLimit = String(req.query.limit || '').trim();
    const rawSiteId = String(req.query.siteId || '').trim();
    const rawSn = String(req.query.sn || '').trim();

    const pin = normalizePin(rawPin);
    const from = normalizeDateFilter(rawFrom);
    const to = normalizeDateFilter(rawTo);
    const limit = rawLimit ? normalizeAttendanceLimit(rawLimit) : 100;
    const siteId = normalizeRecordsScopeValue(rawSiteId);
    const sn = normalizeRecordsScopeValue(rawSn);

    if (rawPin && !pin) {
        return res.status(400).json({ ok: false, error: 'Parametro pin invalido' });
    }

    if (rawFrom && !from) {
        return res.status(400).json({ ok: false, error: 'Parametro from invalido. Usa YYYY-MM-DD' });
    }

    if (rawTo && !to) {
        return res.status(400).json({ ok: false, error: 'Parametro to invalido. Usa YYYY-MM-DD' });
    }

    if (rawLimit && limit === 0) {
        return res.status(400).json({ ok: false, error: 'Parametro limit invalido. Usa un entero entre 1 y 1000' });
    }

    if (req.query.siteId !== undefined && !siteId) {
        return res.status(400).json({ ok: false, error: 'Parametro siteId invalido' });
    }

    if (req.query.sn !== undefined && !sn) {
        return res.status(400).json({ ok: false, error: 'Parametro sn invalido' });
    }

    const records = readAttendanceEntries({
        pin,
        from,
        to,
        limit,
        sn,
        siteId,
        scopeAll: !sn && !siteId
    });

    res.json({
        ok: true,
        source: 'adms-attlog-file',
        mode: 'compat',
        filters: {
            pin: pin || null,
            from: from || null,
            to: to || null,
            limit,
            siteId: siteId || null,
            sn: sn || null
        },
        count: records.length,
        records
    });
}));

app.get('/api/v1/commands', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const records = buildAdmsCommandsReadModel(filters, {
        pin: req.query.pin,
        commandType: req.query.type,
        status: req.query.status,
        commandId: req.query.id
    });

    res.json({
        ok: true,
        commands: records,
        scopeApplied: filters.scopeAll ? 'all' : 'device'
    });
}));

app.get('/api/v1/commands/status', asyncHandler(async (req, res) => {
    const ids = String(req.query.ids || '')
        .split(',')
        .map(value => String(value || '').trim())
        .filter(Boolean);

    if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'Debes enviar ids' });
    }

    res.json({
        ok: true,
        statuses: ids.map(id => readAdmsCommandStatus(id))
    });
}));

app.get('/api/v1/commands/:id', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const command = buildAdmsCommandsReadModel(filters, {
        commandId: req.params.id
    })[0] || null;

    if (!command) {
        return res.status(404).json({ ok: false, error: 'Comando no encontrado' });
    }

    res.json({ ok: true, command });
}));

app.get('/api/v1/sync/status/:pin', asyncHandler(async (req, res) => {
    const pin = normalizePin(req.params.pin);
    if (!pin) {
        return res.status(400).json({ ok: false, error: 'Debes enviar pin valido' });
    }

    res.json({ ok: true, ...(await getAdmsSyncStatus(pin)) });
}));

app.get('/api/v1/admin/entities', asyncHandler(async (_req, res) => {
    res.json({
        ok: true,
        entities: await listAdminEntities()
    });
}));

app.post('/api/v1/admin/entities', asyncHandler(async (req, res) => {
    const entity = await createAdminEntity(req.body || {});
    res.status(201).json({
        ok: true,
        entity
    });
}));

app.patch('/api/v1/admin/entities/:id', asyncHandler(async (req, res) => {
    const entity = await updateAdminEntity(req.params.id, req.body || {});
    res.json({
        ok: true,
        entity
    });
}));

app.delete('/api/v1/admin/entities/:id', asyncHandler(async (req, res) => {
    const entity = await softDeleteAdminEntity(req.params.id);
    res.json({
        ok: true,
        entity
    });
}));

app.get('/api/v1/admin/sites', asyncHandler(async (req, res) => {
    res.status(503).json({
        ok: false,
        message: 'La gestión de sedes no está habilitada en el MVP',
        code: 'SITES_DISABLED'
    });
}));

app.post('/api/v1/admin/sites', asyncHandler(async (req, res) => {
    res.status(503).json({
        ok: false,
        message: 'La gestión de sedes no está habilitada en el MVP',
        code: 'SITES_DISABLED'
    });
}));

app.patch('/api/v1/admin/sites/:id', asyncHandler(async (req, res) => {
    res.status(503).json({
        ok: false,
        message: 'La gestión de sedes no está habilitada en el MVP',
        code: 'SITES_DISABLED'
    });
}));

app.get('/api/v1/admin/devices', asyncHandler(async (req, res) => {
    res.json({
        ok: true,
        devices: await listAdminDevices({
            entidad_id: req.query.entidad_id
        })
    });
}));

app.post('/api/v1/admin/devices', asyncHandler(async (req, res) => {
    const forbiddenField = findDisallowedBodyField(req.body || {}, [
        'entityId',
        'entidad_id',
        'serial',
        'numero_serie',
        'sn',
        'name',
        'nombre',
        'ip'
    ]);
    if (forbiddenField) {
        return res.status(400).json({
            ok: false,
            message: `El campo ${forbiddenField} no está permitido en este endpoint`,
            code: 'INVALID_REQUEST'
        });
    }

    const device = await createAdminDevice(req.body || {});
    res.status(201).json({
        ok: true,
        device
    });
}));

app.patch('/api/v1/admin/devices/:id', asyncHandler(async (req, res) => {
    const forbiddenField = findDisallowedBodyField(req.body || {}, [
        'entityId',
        'entidad_id',
        'serial',
        'numero_serie',
        'sn',
        'name',
        'nombre',
        'ip',
        'status',
        'estado'
    ]);
    if (forbiddenField) {
        return res.status(400).json({
            ok: false,
            message: `El campo ${forbiddenField} no está permitido en este endpoint`,
            code: 'INVALID_REQUEST'
        });
    }

    const device = await updateAdminDevice(req.params.id, req.body || {});
    res.json({
        ok: true,
        device
    });
}));

app.delete('/api/v1/admin/devices/:serial', asyncHandler(async (req, res) => {
    const device = await softDeleteAdminDevice(req.params.serial);
    res.json({
        ok: true,
        device
    });
}));

app.get('/api/v1/admin/api-clients', asyncHandler(async (req, res) => {
    res.json({
        ok: true,
        apiClients: await listAdminApiClients({
            entidad_id: req.query.entidad_id
        })
    });
}));

app.post('/api/v1/admin/api-clients', asyncHandler(async (req, res) => {
    const result = await createAdminApiClient(req.body || {});
    res.status(201).json({
        ok: true,
        apiClient: result.client,
        apiKey: result.apiKey
    });
}));

app.patch('/api/v1/admin/api-clients/:id', asyncHandler(async (req, res) => {
    const apiClient = await updateAdminApiClient(req.params.id, req.body || {});
    res.json({
        ok: true,
        apiClient
    });
}));

app.delete('/api/v1/admin/api-clients/:id', asyncHandler(async (req, res) => {
    const apiClient = await softDeleteAdminApiClient(req.params.id);
    res.json({
        ok: true,
        apiClient
    });
}));

app.get('/api/v1/admin/webhooks', asyncHandler(async (req, res) => {
    const webhooks = await webhookService.listAdminWebhooks({
        entityId: req.query.entityId || req.query.entidad_id,
        event: req.query.event || req.query.eventType || req.query.tipo
    });

    res.json({
        ok: true,
        webhooks
    });
}));

app.post('/api/v1/admin/webhooks', asyncHandler(async (req, res) => {
    const webhook = await webhookService.createAdminWebhook(req.body || {});
    res.status(201).json({
        ok: true,
        webhook
    });
}));

app.patch('/api/v1/admin/webhooks/:id', asyncHandler(async (req, res) => {
    const webhook = await webhookService.updateAdminWebhook(req.params.id, req.body || {});
    res.json({
        ok: true,
        webhook
    });
}));

app.delete('/api/v1/admin/webhooks/:id', asyncHandler(async (req, res) => {
    const webhook = await webhookService.disableAdminWebhook(req.params.id);
    res.json({
        ok: true,
        webhook
    });
}));

app.post('/api/v1/admin/webhooks/:id/test', asyncHandler(async (req, res) => {
    const webhook = await webhookService.getAdminWebhookById(req.params.id);
    if (!webhook) {
        return res.status(404).json({
            ok: false,
            message: 'Webhook no encontrado',
            code: 'WEBHOOK_NOT_FOUND'
        });
    }

    if (webhook.enabled !== true) {
        return res.status(409).json({
            ok: false,
            message: 'El webhook está deshabilitado',
            code: 'WEBHOOK_DISABLED'
        });
    }

    const payload = {
        event: WEBHOOK_EVENT_ATTENDANCE_CREATED,
        nuip: '123456789',
        timestamp: '2026-05-27 10:16:35',
        deviceSerial: 'UDP3253500049',
        receivedAt: new Date().toISOString()
    };
    const delivery = await webhookService.deliverWebhook({ webhook, payload });

    if (!delivery.ok) {
        const code = delivery.code || 'WEBHOOK_DELIVERY_FAILED';
        const statusCode = code === 'INVALID_WEBHOOK_URL' ? 400 : 502;
        return res.status(statusCode).json({
            ok: false,
            message: delivery.error || 'No fue posible entregar el webhook',
            code,
            webhook,
            delivery
        });
    }

    res.json({
        ok: true,
        webhook,
        delivery
    });
}));

function resolveRequestedEntidadId(req, body = {}) {
    return normalizePositiveIntegerId(body.entidad_id || req.query.entidad_id);
}

function resolveApiScopedEntidadId(req, body = {}) {
    if (req.apiKeyAccess?.role === 'client') {
        return normalizePositiveIntegerId(req.apiKeyAccess.entidad_id);
    }

    return resolveRequestedEntidadId(req, body);
}

app.get('/api/v2/devices', asyncHandler(async (req, res) => {
    const scopedEntidadId = resolveApiScopedEntidadId(req);
    const devices = await listAdminDevices({
        entidad_id: scopedEntidadId
    });

    res.json({
        ok: true,
        devices: devices.map(toPublicV2Device)
    });
}));

app.get('/api/v2/persons', asyncHandler(async (req, res) => {
    const scopedEntidadId = resolveApiScopedEntidadId(req);

    // status query param: activo (default), inactivo, all
    const rawStatus = String(req.query.status || '').trim().toLowerCase();
    let estadoFilter;
    if (!rawStatus) {
        estadoFilter = 'activo';
    } else if (rawStatus === 'all') {
        estadoFilter = undefined; // no filtering by estado
    } else if (rawStatus === 'activo' || rawStatus === 'inactivo') {
        estadoFilter = rawStatus;
    } else {
        // invalid -> default to activo
        estadoFilter = 'activo';
    }

    const filters = {
        nuip: req.query.nuip,
        entidad_id: scopedEntidadId
    };
    if (estadoFilter !== undefined) filters.estado = estadoFilter;

    const persons = await listMysqlPersons(filters);
    return res.json({ ok: true, persons: persons.map(toPublicPerson) });
}));

app.post('/api/v2/persons', upload.single('image'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const normalizedNuip = normalizeNuip(body.nuip);
    const scopedEntidadId = resolveApiScopedEntidadId(req, body);
    const forbiddenField = findDisallowedBodyField(body, ['nuip', 'name', 'password', 'targetDeviceSn']);

    if (forbiddenField) {
        return res.status(400).json({
            ok: false,
            message: `El campo ${forbiddenField} no está permitido en este endpoint`,
            code: 'INVALID_REQUEST'
        });
    }

    if (!String(body.targetDeviceSn || '').trim()) {
        return res.status(400).json({
            ok: false,
            message: 'targetDeviceSn requerido',
            code: 'INVALID_REQUEST'
        });
    }

    const requestsDeviceSync =
        toBooleanFlag(body.syncDevice) ||
        req.file != null ||
        body.password !== undefined ||
        body.targetDeviceSn !== undefined;
    const effectiveBody = {
        ...body,
        entidad_id: scopedEntidadId || body.entidad_id
    };
    const existingPerson = normalizedNuip
        ? await resolveEntityScopedMysqlPerson(normalizedNuip, { entidad_id: scopedEntidadId })
        : null;

    if (existingPerson && existingPerson.estado === 'activo') {
        return res.status(409).json({
            ok: false,
            message: 'Ya existe una persona activa con este NUIP',
            code: 'PERSON_ALREADY_EXISTS'
        });
    }

    if (existingPerson && existingPerson.estado === 'inactivo') {
        await assertMysqlPersonDeviceAssignmentAllowed({
            personId: existingPerson.id,
            entidadId: scopedEntidadId || existingPerson.entidad_id,
            targetDeviceSn: body.targetDeviceSn,
            pinDispositivo: normalizedNuip
        });

        const reactivationPayload = {
            ...(await buildMysqlPersonPayloadFromPublicBody(effectiveBody, { requireName: false, entidad_id: scopedEntidadId })),
            estado: 'activo'
        };
        const reactivatedPerson = await updateMysqlPersonByNuip(existingPerson.nuip, reactivationPayload, { entidad_id: scopedEntidadId });

        if (!requestsDeviceSync) {
            return res.status(200).json({
                ok: true,
                message: 'Persona reactivada correctamente',
                person: toPublicPerson(reactivatedPerson),
                deviceSync: {
                    requested: false
                }
            });
        }

        const syncBody = { ...effectiveBody };
        if (effectiveBody.targetDeviceSn !== undefined) {
            syncBody.pin_dispositivo = normalizedNuip;
            if (syncBody.name === undefined) {
                syncBody.name = reactivatedPerson.nombre_completo || reactivatedPerson.nombres;
            }
        }

        const result = await performMysqlPersonPatchWithOptionalDeviceSync({
            nuip: reactivatedPerson.nuip,
            body: syncBody,
            file: req.file || null,
            entidadId: scopedEntidadId
        });
        const publicCommands = result.deviceSync?.commands
            ? result.deviceSync.commands.map(toPublicCommand)
            : [];

        return res.status(200).json({
            ok: true,
            message: 'Persona reactivada correctamente',
            person: toPublicPerson(result.person || reactivatedPerson),
            deviceSync: {
                requested: result.deviceSync?.requested || false,
                commands: publicCommands
            }
        });
    }

    const personPayload = {
        nuip: normalizedNuip,
        entidad_id: scopedEntidadId || undefined,
        ...(await buildMysqlPersonPayloadFromPublicBody(effectiveBody, { requireName: true, entidad_id: scopedEntidadId }))
    };

    await assertMysqlPersonDeviceAssignmentAllowed({
        entidadId: personPayload.entidad_id,
        targetDeviceSn: body.targetDeviceSn,
        pinDispositivo: normalizedNuip
    });

    const person = await createMysqlPerson(personPayload);

    if (!requestsDeviceSync) {
        return res.status(201).json({
            ok: true,
            message: 'Persona creada correctamente',
            person: toPublicPerson(person),
            deviceSync: {
                requested: false,
                commands: []
            }
        });
    }

    const result = await performMysqlPersonPatchWithOptionalDeviceSync({
        nuip: person.nuip,
        body: effectiveBody,
        file: req.file || null,
        entidadId: scopedEntidadId
    });
    const publicCommands = result.deviceSync?.commands
        ? result.deviceSync.commands.map(toPublicCommand)
        : [];

    res.status(201).json({
        ok: true,
        message: 'Persona creada correctamente',
        person: toPublicPerson(result.person || person),
        deviceSync: {
            requested: true,
            commands: publicCommands
        }
    });
}));

app.get('/api/v2/persons/:nuip', asyncHandler(async (req, res) => {
    const nuip = String(req.params.nuip || '').trim();
    const mysqlPerson = await resolveEntityScopedMysqlPerson(nuip, {
        entidad_id: resolveApiScopedEntidadId(req)
    });
    if (!mysqlPerson) {
        return res.status(404).json({
            ok: false,
            message: 'No se encontró una persona con el NUIP indicado',
            code: 'PERSON_NOT_FOUND'
        });
    }

    res.json({
        ok: true,
        person: toPublicPerson(mysqlPerson)
    });
}));

app.patch('/api/v2/persons/:nuip', upload.single('image'), asyncHandler(async (req, res) => {
    const body = req.body || {};
    const scopedEntidadId = resolveApiScopedEntidadId(req, body);
    const forbiddenField = findDisallowedBodyField(body, ['name', 'password', 'targetDeviceSn']);

    if (forbiddenField) {
        return res.status(400).json({
            ok: false,
            message: `El campo ${forbiddenField} no está permitido en este endpoint`,
            code: 'INVALID_REQUEST'
        });
    }

    if (!String(body.targetDeviceSn || '').trim()) {
        return res.status(400).json({
            ok: false,
            message: 'targetDeviceSn requerido',
            code: 'INVALID_REQUEST'
        });
    }

    const effectiveBody = {
        ...body,
        entidad_id: scopedEntidadId || body.entidad_id
    };
    const existingMysqlPerson = await resolveEntityScopedMysqlPerson(req.params.nuip, {
        entidad_id: scopedEntidadId
    });
    if (!existingMysqlPerson) {
        return res.status(404).json({
            ok: false,
            message: 'No se encontró una persona con el NUIP indicado',
            code: 'PERSON_NOT_FOUND'
        });
    }

    if (existingMysqlPerson.estado === 'inactivo') {
        return res.status(409).json({
            ok: false,
            message: 'La persona está inactiva. Reactívala usando POST antes de actualizarla.',
            code: 'PERSON_INACTIVE'
        });
    }

    const result = await performMysqlPersonPatchWithOptionalDeviceSync({
        nuip: req.params.nuip,
        body: effectiveBody,
        file: req.file || null,
        entidadId: scopedEntidadId
    });

    const publicCommands = result.deviceSync?.commands
        ? result.deviceSync.commands.map(toPublicCommand)
        : [];

    return res.status(200).json({
        ok: true,
        message: 'Persona actualizada correctamente',
        person: toPublicPerson(result.person),
        deviceSync: {
            requested: result.deviceSync?.requested || false,
            commands: publicCommands
        }
    });
}));

app.delete('/api/v2/persons/:nuip', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const scopedEntidadId = resolveApiScopedEntidadId(req, body);
    const routeNuip = normalizeNuip(String(req.params.nuip || ''));
    const rawTargetDeviceSn = String(body.targetDeviceSn || req.query.targetDeviceSn || '').trim();
    const targetDeviceSn = normalizeRecordsScopeValue(rawTargetDeviceSn);
    const forbiddenField = findDisallowedBodyField(body, ['targetDeviceSn']);

    if (!routeNuip) {
        return res.status(400).json({
            ok: false,
            message: 'NUIP requerido',
            code: 'VALIDATION_ERROR'
        });
    }

    if (forbiddenField) {
        return res.status(400).json({
            ok: false,
            message: `El campo ${forbiddenField} no está permitido en este endpoint`,
            code: 'INVALID_REQUEST'
        });
    }

    if (!targetDeviceSn) {
        return res.status(400).json({
            ok: false,
            message: 'targetDeviceSn requerido',
            code: 'INVALID_REQUEST'
        });
    }

    const person = await resolveEntityScopedMysqlPerson(routeNuip, {
        entidad_id: scopedEntidadId
    });
    if (!person) {
        return res.status(404).json({
            ok: false,
            message: 'No se encontró una persona con el NUIP indicado',
            code: 'PERSON_NOT_FOUND'
        });
    }

    if (person.estado === 'inactivo') {
        return res.status(200).json({
            ok: true,
            message: 'La persona ya fue desactivada anteriormente'
        });
    }

    const normalizedTargetDeviceSn = String(targetDeviceSn || '').trim();
    const mysqlDevice = await readMysqlDeviceBySerial(normalizedTargetDeviceSn);
    if (!mysqlDevice) {
        return res.status(404).json({ ok: false, message: 'Dispositivo no encontrado para targetDeviceSn', code: 'DEVICE_NOT_FOUND' });
    }
    if (scopedEntidadId && normalizePositiveIntegerId(mysqlDevice?.entidad_id) !== scopedEntidadId) {
        return res.status(403).json({ ok: false, message: 'El dispositivo no pertenece a la entidad de esta API key', code: 'DEVICE_NOT_ALLOWED' });
    }

    const updatedPerson = await deactivateMysqlPersonByNuip(routeNuip, { entidad_id: scopedEntidadId });
    const deviceProfiles = Array.isArray(person.persona_dispositivos) ? person.persona_dispositivos : [];
    const relation = deviceProfiles.find(entry => {
        const entrySn = String(entry.numero_serie || '').trim();
        return entrySn === normalizedTargetDeviceSn;
    });

    const pinForDevice = normalizePin(relation?.pin_dispositivo) || routeNuip;
    const targetContext = resolveCommandTargetMetadata({ targetDeviceSn: normalizedTargetDeviceSn });

    const deleteCommandId = allocateAdmsCommandId();
    const deleteCommand = `C:${deleteCommandId}:DATA DELETE USERINFO PIN=${pinForDevice}`;

    const queueEntry = enqueueAdmsCommandEntry({
        commandId: deleteCommandId,
        commandType: 'DELETE_USERINFO',
        pin: pinForDevice,
        command: deleteCommand,
        purpose: 'delete-person',
        ...targetContext
    });

    if (mysqlDevice?.id && updatedPerson?.id) {
        await deactivateMysqlPersonDeviceRelation(updatedPerson.id, mysqlDevice.id);
    }

    res.json({
        ok: true,
        message: 'Persona desactivada correctamente',
        commandId: String(queueEntry.commandId || deleteCommandId)
    });
}));

app.get('/api/v2/commands/:id', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    const scopedEntidadId = resolveApiScopedEntidadId(req);

    const respondWithCommand = async command => {
        if (!command) {
            return false;
        }

        if (scopedEntidadId) {
            const entityDeviceSerials = await readEntityDeviceSerials(scopedEntidadId);
            if (!commandBelongsToEntity(command, entityDeviceSerials)) {
                return false;
            }
        }

        res.json({ ok: true, command: toPublicCommand(command) });
        return true;
    };

    try {
        const mysqlCommand = await readMysqlAdmsCommandStatus(req.params.id);
        if (await respondWithCommand(mysqlCommand)) {
            return;
        }
    } catch (error) {
        logStore.warn('adms.command.mysql-read.error', {
            commandId: String(req.params.id || ''),
            error: error.message
        });
    }

    const legacyCommand = buildAdmsCommandsReadModel(filters, {
        commandId: req.params.id
    })[0] || null;

    if (await respondWithCommand(legacyCommand)) {
        return;
    }

    res.status(404).json({ ok: false, error: 'Comando no encontrado' });
}));

app.get('/api/v2/attendance', asyncHandler(async (req, res) => {
    const rawNuip = String(req.query.nuip || '').trim();
    const rawFrom = String(req.query.from || '').trim();
    const rawTo = String(req.query.to || '').trim();
    const rawLimit = String(req.query.limit || '').trim();
    const scopedEntidadId = resolveApiScopedEntidadId(req);
    const from = normalizeDateFilter(rawFrom);
    const to = normalizeDateFilter(rawTo);
    const limit = rawLimit ? normalizeAttendanceLimit(rawLimit) : 100;

    if (rawFrom && !from) {
        return res.status(400).json({ ok: false, error: 'Parametro from invalido. Usa YYYY-MM-DD' });
    }

    if (rawTo && !to) {
        return res.status(400).json({ ok: false, error: 'Parametro to invalido. Usa YYYY-MM-DD' });
    }

    if (rawLimit && limit === 0) {
        return res.status(400).json({ ok: false, error: 'Parametro limit invalido. Usa un entero entre 1 y 1000' });
    }

    let records = await listMysqlAttendanceRecords({
        entidad_id: scopedEntidadId,
        nuip: rawNuip,
        from,
        to,
        limit
    });

    if (records === null) {
        let pin = '';
        if (rawNuip) {
            const person = await resolveEntityScopedMysqlPerson(rawNuip, {
                entidad_id: scopedEntidadId
            });
            if (!person) {
                return res.json({
                    ok: true,
                    filters: {
                        from: from || null,
                        to: to || null,
                        nuip: rawNuip || null,
                        limit
                    },
                    count: 0,
                    records: []
                });
            }

            const firstRelation = Array.isArray(person.persona_dispositivos) ? person.persona_dispositivos[0] : null;
            pin = normalizePin(firstRelation?.pin_dispositivo) || normalizeNuip(person.nuip);
        }

        records = readAttendanceEntries({
            pin,
            from,
            to,
            limit: 0
        });

        if (scopedEntidadId) {
            const entityDeviceSerials = await readEntityDeviceSerials(scopedEntidadId);
            records = records.filter(entry => attendanceBelongsToEntity(entry, entityDeviceSerials));
        }

        if (limit > 0) {
            records = records.slice(0, limit);
        }
    }

    res.json({
        ok: true,
        filters: {
            from: from || null,
            to: to || null,
            nuip: rawNuip || null,
            limit
        },
        count: records.length,
        records: records.map(toPublicAttendanceRecord)
    });
}));

app.get('/adms/devices', asyncHandler(async (_req, res) => {
    try {
        const devices = readAdmsDevices();
        res.json(devices);
    } catch (error) {
        console.error('Error leyendo dispositivos:', error);
        res.json({
            ok: false,
            error: 'No fue posible consultar dispositivos',
            devices: []
        });
    }
}));

app.get('/adms/records/devices', asyncHandler(async (req, res) => {
    const filters = getRecordsScopeFilters(req);
    try {
        const devices = readAdmsDevices()
            .filter(device => matchesScopedRecord(device, filters, { snFields: ['sn'], siteIdFields: ['siteId'] }));
        res.json(devices);
    } catch (error) {
        console.error('Error leyendo dispositivos:', error);
        res.json({
            ok: false,
            error: 'No fue posible consultar dispositivos',
            devices: []
        });
    }
}));

function resolveZkOptions(req) {
    const source = req.method === 'GET' ? req.query : req.body;
    return {
        ip: String(source.ip || config.zk.ip || '').trim(),
        port: parseInteger(source.port, config.zk.port),
        timeoutMs: parseInteger(source.timeoutMs, config.zk.timeoutMs)
    };
}

function asyncHandler(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

// Global error handler middleware for public API
app.use((err, req, res, next) => {
    const isPublicRoute = req.path.startsWith('/api/v1/') || req.path.startsWith('/api/v2/');
    
    // Always respond with JSON for /api/v1/* routes
    if (isPublicRoute) {
        const statusCode = err.statusCode || err.status || 500;
        const message = err.message || 'Error procesando la solicitud';
        
        // Log error internally for debugging
        logStore.error('api.error', {
            path: req.path,
            method: req.method,
            statusCode,
            message,
            timestamp: new Date().toISOString()
        });
        
        // Detect common errors
        let code = 'INTERNAL_ERROR';
        let publicMessage = message;
        // honor explicit error.code set by internal logic
        if (err.code) {
            code = String(err.code || '').trim() || code;
        }
        
        // MySQL duplicate key error
        if (err.code === 'ER_DUP_ENTRY' || message.includes('Duplicate entry')) {
            if (message.includes('nuip')) {
                code = 'PERSON_ALREADY_EXISTS';
                publicMessage = 'Ya existe una persona registrada con este NUIP';
                return res.status(409).json({ ok: false, message: publicMessage, code });
            }
        }

        if (statusCode === 409 && message === 'pin_dispositivo ya esta asignado a otra persona en ese dispositivo') {
            code = 'NUIP_ALREADY_ASSIGNED_TO_DEVICE';
            publicMessage = 'Este NUIP ya está asignado a otra persona en el dispositivo indicado';
        }
        
        // Validation errors
        if (statusCode === 400) {
            code = message.includes('VALIDATION') ? 'VALIDATION_ERROR' : 'INVALID_REQUEST';
            if (message.includes('JSON')) {
                code = 'INVALID_JSON';
                publicMessage = 'El cuerpo de la solicitud no tiene un formato JSON válido';
            }
        }
        
        // Person not found
        if (statusCode === 404 && message.includes('Persona')) {
            code = 'PERSON_NOT_FOUND';
            publicMessage = 'No se encontró una persona con el NUIP indicado';
        }
        
        // Generic 500 error for public API
        if (statusCode === 500) {
            publicMessage = 'Error interno del servidor';
        }
        
        return res.status(statusCode).json({
            ok: false,
            message: publicMessage,
            code
        });
    }
    
    // For non-API routes, use default error handling
    res.status(err.statusCode || err.status || 500).send(err.message || 'Internal Server Error');
});

app.listen(config.server.port, () => {
    console.log(`Servidor corriendo en puerto ${config.server.port}`);
});
