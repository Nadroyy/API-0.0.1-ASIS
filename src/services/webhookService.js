const WEBHOOK_EVENT_ATTENDANCE_CREATED = 'attendance.created';

function normalizePositiveIntegerId(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBooleanFlag(value, fallback = null) {
    if (value === undefined || value === null) {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
        return fallback;
    }

    if (['1', 'true', 'si', 's\u00ed', 'yes', 'on', 'activo', 'enabled'].includes(raw)) {
        return true;
    }

    if (['0', 'false', 'no', 'off', 'inactivo', 'disabled'].includes(raw)) {
        return false;
    }

    return fallback;
}

function createWebhookService({ db, logStore }) {
    async function mysqlTableExists(tableName) {
        const [rows] = await db.query('SHOW TABLES LIKE ?', [String(tableName || '').trim()]);
        return Array.isArray(rows) && rows.length > 0;
    }

    async function ensureWebhookTable() {
        if (await mysqlTableExists('entidad_urls')) {
            return;
        }

        const error = new Error('La tabla entidad_urls no existe');
        error.statusCode = 500;
        throw error;
    }

    function toPublicWebhook(row) {
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            entityId: row.entidad_id,
            event: row.event_type,
            url: row.url,
            enabled: normalizeBooleanFlag(row.enabled, false) === true,
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null
        };
    }

    function normalizeWebhookUrl(value) {
        const raw = String(value || '').trim();
        if (!raw || raw.includes('{{') || raw.includes('}}')) {
            const error = new Error('URL de webhook invalida');
            error.statusCode = 400;
            error.code = 'INVALID_WEBHOOK_URL';
            throw error;
        }

        let parsed;
        try {
            parsed = new URL(raw);
        } catch (_error) {
            const error = new Error('URL de webhook invalida');
            error.statusCode = 400;
            error.code = 'INVALID_WEBHOOK_URL';
            throw error;
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            const error = new Error('URL de webhook invalida');
            error.statusCode = 400;
            error.code = 'INVALID_WEBHOOK_URL';
            throw error;
        }

        return parsed.toString();
    }

    async function assertNoActiveWebhookDuplicate({ entityId, event, url, excludeId = null }) {
        const normalizedEntityId = normalizePositiveIntegerId(entityId);
        const normalizedEvent = String(event || '').trim();
        const normalizedUrl = normalizeWebhookUrl(url);
        const normalizedExcludeId = normalizePositiveIntegerId(excludeId);

        const params = [normalizedEntityId, normalizedEvent, normalizedUrl];
        const excludeClause = normalizedExcludeId ? 'AND id <> ?' : '';
        if (normalizedExcludeId) {
            params.push(normalizedExcludeId);
        }

        const [rows] = await db.query(`
            SELECT id
            FROM entidad_urls
            WHERE entidad_id = ?
              AND event_type = ?
              AND url = ?
              AND enabled = 1
              ${excludeClause}
            LIMIT 1
        `, params);

        if (Array.isArray(rows) && rows[0]) {
            const error = new Error('Ya existe un webhook activo para esta entidad, evento y URL');
            error.statusCode = 409;
            error.code = 'WEBHOOK_ALREADY_EXISTS';
            throw error;
        }

        return normalizedUrl;
    }

    async function listAdminWebhooks(filters = {}) {
        await ensureWebhookTable();
        const clauses = [];
        const params = [];

        const entityId = normalizePositiveIntegerId(filters.entityId || filters.entidad_id);
        if (entityId) {
            clauses.push('entidad_id = ?');
            params.push(entityId);
        }

        if (filters.event) {
            clauses.push('event_type = ?');
            params.push(String(filters.event || '').trim());
        }

        const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        const [rows] = await db.query(`
            SELECT *
            FROM entidad_urls
            ${whereClause}
            ORDER BY updated_at DESC, id DESC
        `, params);

        return (Array.isArray(rows) ? rows : []).map(toPublicWebhook);
    }

    async function getAdminWebhookById(id) {
        await ensureWebhookTable();
        const webhookId = normalizePositiveIntegerId(id);
        if (!webhookId) {
            const error = new Error('webhookId invalido');
            error.statusCode = 400;
            throw error;
        }

        const [rows] = await db.query(`
            SELECT *
            FROM entidad_urls
            WHERE id = ?
            LIMIT 1
        `, [webhookId]);

        return Array.isArray(rows) && rows[0] ? toPublicWebhook(rows[0]) : null;
    }

    async function createAdminWebhook(payload = {}) {
        await ensureWebhookTable();
        const entityId = normalizePositiveIntegerId(payload.entityId || payload.entidad_id);
        const event = String(payload.event || payload.eventType || payload.tipo || '').trim();
        const url = normalizeWebhookUrl(payload.url);
        const enabled = normalizeBooleanFlag(
            payload.enabled !== undefined ? payload.enabled : payload.activo,
            true
        );

        if (!entityId || !event || !url) {
            const error = new Error('entityId, event y url son obligatorios');
            error.statusCode = 400;
            throw error;
        }

        if (event !== WEBHOOK_EVENT_ATTENDANCE_CREATED) {
            const error = new Error('Solo se permite el evento attendance.created en este MVP');
            error.statusCode = 400;
            throw error;
        }

        if (enabled) {
            await assertNoActiveWebhookDuplicate({ entityId, event, url });
        }

        const [result] = await db.query(`
            INSERT INTO entidad_urls (entidad_id, event_type, url, enabled)
            VALUES (?, ?, ?, ?)
        `, [entityId, event, url, enabled ? 1 : 0]);

        const [rows] = await db.query(`
            SELECT *
            FROM entidad_urls
            WHERE id = ?
            LIMIT 1
        `, [result.insertId]);

        return Array.isArray(rows) && rows[0] ? toPublicWebhook(rows[0]) : null;
    }

    async function updateAdminWebhook(id, payload = {}) {
        await ensureWebhookTable();
        const webhookId = normalizePositiveIntegerId(id);
        if (!webhookId) {
            const error = new Error('webhookId invalido');
            error.statusCode = 400;
            throw error;
        }

        const currentWebhook = await getAdminWebhookById(webhookId);
        if (!currentWebhook) {
            const error = new Error('Webhook no encontrado');
            error.statusCode = 404;
            error.code = 'WEBHOOK_NOT_FOUND';
            throw error;
        }

        const updates = [];
        const params = [];
        let nextEntityId = currentWebhook.entityId;
        let nextEvent = currentWebhook.event;
        let nextUrl = currentWebhook.url;
        let nextEnabled = currentWebhook.enabled;

        const entityId = payload.entityId !== undefined || payload.entidad_id !== undefined
            ? normalizePositiveIntegerId(payload.entityId || payload.entidad_id)
            : null;
        if (entityId !== null) {
            updates.push('entidad_id = ?');
            params.push(entityId);
            nextEntityId = entityId;
        }

        if (payload.event !== undefined || payload.eventType !== undefined || payload.tipo !== undefined) {
            const event = String(payload.event || payload.eventType || payload.tipo || '').trim();
            if (event !== WEBHOOK_EVENT_ATTENDANCE_CREATED) {
                const error = new Error('Solo se permite el evento attendance.created en este MVP');
                error.statusCode = 400;
                throw error;
            }
            updates.push('event_type = ?');
            params.push(event);
            nextEvent = event;
        }

        if (payload.url !== undefined) {
            const url = normalizeWebhookUrl(payload.url);
            updates.push('url = ?');
            params.push(url);
            nextUrl = url;
        }

        const enabled = normalizeBooleanFlag(
            payload.enabled !== undefined ? payload.enabled : payload.activo,
            null
        );
        if (enabled !== null) {
            updates.push('enabled = ?');
            params.push(enabled ? 1 : 0);
            nextEnabled = enabled;
        }

        if (updates.length === 0) {
            const error = new Error('Debes enviar al menos un campo actualizable');
            error.statusCode = 400;
            throw error;
        }

        if (nextEnabled) {
            const normalizedUrl = await assertNoActiveWebhookDuplicate({
                entityId: nextEntityId,
                event: nextEvent,
                url: nextUrl,
                excludeId: webhookId
            });
            nextUrl = normalizedUrl;
        }

        params.push(webhookId);
        await db.query(`
            UPDATE entidad_urls
            SET ${updates.join(', ')}
            WHERE id = ?
        `, params);

        const [rows] = await db.query(`
            SELECT *
            FROM entidad_urls
            WHERE id = ?
            LIMIT 1
        `, [webhookId]);

        return Array.isArray(rows) && rows[0] ? toPublicWebhook(rows[0]) : null;
    }

    async function disableAdminWebhook(id) {
        return updateAdminWebhook(id, { enabled: false });
    }

    async function findActiveAttendanceWebhooksByEntity(entityId) {
        await ensureWebhookTable();
        const normalizedEntityId = normalizePositiveIntegerId(entityId);
        if (!normalizedEntityId) {
            return [];
        }

        const [rows] = await db.query(`
            SELECT *
            FROM entidad_urls
            WHERE entidad_id = ?
              AND event_type = ?
              AND enabled = 1
            ORDER BY id ASC
        `, [normalizedEntityId, WEBHOOK_EVENT_ATTENDANCE_CREATED]);

        return (Array.isArray(rows) ? rows : []).map(toPublicWebhook);
    }

    async function deliverWebhook({ webhook, payload, timeoutMs = 5000 }) {
        let targetUrl = '';
        try {
            targetUrl = normalizeWebhookUrl(webhook?.url);
        } catch (error) {
            return {
                ok: false,
                status: null,
                code: 'INVALID_WEBHOOK_URL',
                error: error.code || 'INVALID_WEBHOOK_URL'
            };
        }

        if (typeof fetch !== 'function') {
            return {
                ok: false,
                status: null,
                error: 'fetch no esta disponible en este runtime'
            };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            return {
                ok: response.ok,
                status: response.status,
                error: response.ok ? null : `HTTP ${response.status}`
            };
        } catch (error) {
            return {
                ok: false,
                status: null,
                error: String(error?.message || error)
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    async function emitAttendanceCreatedWebhook(attendanceRecord) {
        try {
            const entityId = normalizePositiveIntegerId(attendanceRecord?.entidad_id);
            const deviceSerial = String(attendanceRecord?.deviceSerial || '').trim();
            if (!entityId || !deviceSerial) {
                return;
            }

            const webhooks = await findActiveAttendanceWebhooksByEntity(entityId);
            if (webhooks.length === 0) {
                return;
            }

            const payload = {
                event: WEBHOOK_EVENT_ATTENDANCE_CREATED,
                nuip: attendanceRecord.nuip || null,
                timestamp: attendanceRecord.timestamp || null,
                deviceSerial,
                receivedAt: attendanceRecord.receivedAt || null
            };

            const results = await Promise.allSettled(
                webhooks.map(async webhook => {
                    const delivery = await deliverWebhook({ webhook, payload });
                    if (!delivery.ok) {
                        logStore?.warn?.('webhook.delivery.failed', {
                            webhookId: webhook.id,
                            entityId,
                            event: payload.event,
                            url: webhook.url,
                            status: delivery.status,
                            error: delivery.error
                        });
                    }
                    return delivery;
                })
            );

            return results;
        } catch (error) {
            logStore?.error?.('webhook.attendance.emit.error', {
                message: String(error?.message || error),
                attendanceRecord
            });
            return null;
        }
    }

    return {
        WEBHOOK_EVENT_ATTENDANCE_CREATED,
        getAdminWebhookById,
        listAdminWebhooks,
        createAdminWebhook,
        updateAdminWebhook,
        disableAdminWebhook,
        deliverWebhook,
        emitAttendanceCreatedWebhook
    };
}

module.exports = {
    createWebhookService,
    WEBHOOK_EVENT_ATTENDANCE_CREATED
};
