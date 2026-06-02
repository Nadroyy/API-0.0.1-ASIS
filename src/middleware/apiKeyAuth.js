const crypto = require('crypto');

let authResolvers = {
    findClientCredentialByPrefix: async () => null,
    markClientCredentialUsed: async () => {}
};

function configureApiKeyAuth(resolvers = {}) {
    authResolvers = {
        ...authResolvers,
        ...resolvers
    };
}

function safeEqualsApiKey(expected, candidate) {
    const left = Buffer.from(String(expected || ''), 'utf8');
    const right = Buffer.from(String(candidate || ''), 'utf8');
    if (left.length !== right.length) {
        return false;
    }
    return crypto.timingSafeEqual(left, right);
}

function extractApiKeyFromRequest(req) {
    const xApiKey = String(req.get('X-API-Key') || '').trim();
    if (xApiKey) {
        return xApiKey;
    }

    const authorization = String(req.get('Authorization') || '').trim();
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    return bearerMatch ? String(bearerMatch[1] || '').trim() : '';
}

function getConfiguredAdminApiKey() {
    return String(process.env.ADMIN_API_KEY || process.env.API_V1_KEY || '').trim();
}

function buildApiKeyPrefix(rawKey) {
    return String(rawKey || '').trim().slice(0, 24);
}

function hashApiKey(rawKey) {
    return crypto.createHash('sha256').update(String(rawKey || ''), 'utf8').digest('hex');
}

async function resolveApiKeyAccess(req) {
    const providedKey = extractApiKeyFromRequest(req);
    const adminApiKey = getConfiguredAdminApiKey();

    if (!providedKey) {
        return {
            providedKey: '',
            role: null,
            entidad_id: null,
            credential_id: null,
            valid: false
        };
    }

    if (adminApiKey && safeEqualsApiKey(adminApiKey, providedKey)) {
        return {
            providedKey,
            role: 'admin',
            entidad_id: null,
            credential_id: null,
            valid: true
        };
    }

    const keyPrefix = buildApiKeyPrefix(providedKey);
    const credential = keyPrefix
        ? await authResolvers.findClientCredentialByPrefix(keyPrefix)
        : null;

    if (!credential || credential.enabled === false) {
        return {
            providedKey,
            role: null,
            entidad_id: null,
            credential_id: null,
            valid: false
        };
    }

    const candidateHash = hashApiKey(providedKey);
    if (!safeEqualsApiKey(String(credential.key_hash || ''), candidateHash)) {
        return {
            providedKey,
            role: null,
            entidad_id: null,
            credential_id: null,
            valid: false
        };
    }

    await authResolvers.markClientCredentialUsed(credential.id);

    return {
        providedKey,
        role: 'client',
        entidad_id: credential.entidad_id,
        credential_id: credential.id,
        valid: true
    };
}

function respondApiKeyError(res, statusCode, message, code) {
    return res.status(statusCode).json({
        ok: false,
        message,
        code
    });
}

function requireAdminApiKey(req, res, next) {
    const adminApiKey = getConfiguredAdminApiKey();
    if (!adminApiKey) {
        return res.status(500).json({
            ok: false,
            message: 'ADMIN_API_KEY no configurada',
            code: 'API_KEY_NOT_CONFIGURED'
        });
    }

    resolveApiKeyAccess(req)
        .then(access => {
            req.apiKeyAccess = access;

            if (!access.providedKey) {
                return respondApiKeyError(res, 401, 'API key requerida', 'API_KEY_REQUIRED');
            }

            if (access.role === 'admin') {
                return next();
            }

            if (access.role === 'client') {
                return respondApiKeyError(res, 403, 'La API key no tiene permisos para este recurso', 'API_KEY_FORBIDDEN');
            }

            return respondApiKeyError(res, 403, 'API key inválida', 'API_KEY_INVALID');
        })
        .catch(next);
}

function requireClientOrAdminApiKey(req, res, next) {
    const adminApiKey = getConfiguredAdminApiKey();
    if (!adminApiKey) {
        return res.status(500).json({
            ok: false,
            message: 'ADMIN_API_KEY no configurada',
            code: 'API_KEY_NOT_CONFIGURED'
        });
    }

    resolveApiKeyAccess(req)
        .then(access => {
            req.apiKeyAccess = access;

            if (!access.providedKey) {
                return respondApiKeyError(res, 401, 'API key requerida', 'API_KEY_REQUIRED');
            }

            if (access.role === 'admin' || access.role === 'client') {
                return next();
            }

            return respondApiKeyError(res, 403, 'API key inválida', 'API_KEY_INVALID');
        })
        .catch(next);
}

module.exports = {
    configureApiKeyAuth,
    safeEqualsApiKey,
    extractApiKeyFromRequest,
    getConfiguredAdminApiKey,
    buildApiKeyPrefix,
    hashApiKey,
    resolveApiKeyAccess,
    requireAdminApiKey,
    requireClientOrAdminApiKey
};
