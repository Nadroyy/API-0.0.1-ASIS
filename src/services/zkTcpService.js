const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

function createZkTcpService({ defaults, logStore }) {
    const bridgeScriptPath = path.join(__dirname, '..', 'python', 'zk_tcp_bridge.py');

    function resolveOptions(options = {}) {
        const ip = String(options.ip || defaults.ip || '').trim();
        const port = Number.parseInt(options.port, 10) || defaults.port || 4370;
        const timeoutMs = Number.parseInt(options.timeoutMs, 10) || defaults.timeoutMs || 5000;

        if (!ip) {
            const error = new Error('Falta configurar la IP del dispositivo ZKTeco');
            error.statusCode = 400;
            error.code = 'ZK_IP_REQUIRED';
            throw error;
        }

        return {
            ...options,
            ip,
            port,
            timeoutMs
        };
    }

    async function ping(options) {
        const resolved = resolveOptions(options);
        const start = process.hrtime.bigint();

        return new Promise(resolve => {
            const socket = new net.Socket();
            let settled = false;

            const finish = (ok, extra = {}) => {
                if (settled) {
                    return;
                }

                settled = true;
                const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
                const result = {
                    ok,
                    type: 'tcp',
                    ip: resolved.ip,
                    port: resolved.port,
                    responseTimeMs: Number(durationMs.toFixed(2)),
                    timestamp: new Date().toISOString(),
                    ...extra
                };

                if (ok) {
                    logStore.info('zk.tcp.ping.success', result);
                } else {
                    logStore.warn('zk.tcp.ping.failed', result);
                }

                socket.destroy();
                resolve(result);
            };

            socket.setTimeout(resolved.timeoutMs);
            socket.once('connect', () => finish(true, { message: 'Puerto TCP 4370 accesible' }));
            socket.once('timeout', () => finish(false, { error: 'Tiempo de espera agotado' }));
            socket.once('error', error => finish(false, { error: error.message, code: error.code || null }));
            socket.connect(resolved.port, resolved.ip);
        });
    }

    async function runBridge(action, options) {
        const resolved = resolveOptions(options);
        const payload = JSON.stringify(resolved);
        const startedAt = process.hrtime.bigint();

        return new Promise((resolve, reject) => {
            const child = spawn(defaults.pythonBin || 'python', [bridgeScriptPath, action], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    child.kill();
                    const error = new Error(`Bridge Python excedio el timeout de ${resolved.timeoutMs}ms`);
                    error.code = 'PYTHON_BRIDGE_TIMEOUT';
                    error.statusCode = 504;
                    logStore.error('zk.bridge.timeout', {
                        action,
                        ip: resolved.ip,
                        port: resolved.port,
                        timeoutMs: resolved.timeoutMs
                    });
                    reject(error);
                }
            }, resolved.timeoutMs + 1500);

            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
            });

            child.stderr.on('data', chunk => {
                stderr += chunk.toString();
            });

            child.on('error', error => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                error.statusCode = 500;
                error.code = error.code || 'PYTHON_BRIDGE_SPAWN_ERROR';
                logStore.error('zk.bridge.spawn-error', {
                    action,
                    message: error.message
                });
                reject(error);
            });

            child.on('close', code => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);

                let parsed;
                try {
                    parsed = stdout ? JSON.parse(stdout) : null;
                } catch (error) {
                    const parseError = new Error(`Respuesta invalida del bridge Python: ${stdout || stderr || 'vacia'}`);
                    parseError.statusCode = 502;
                    parseError.code = 'PYTHON_BRIDGE_INVALID_JSON';
                    logStore.error('zk.bridge.invalid-json', {
                        action,
                        stdout,
                        stderr
                    });
                    reject(parseError);
                    return;
                }

                if (!parsed) {
                    const emptyError = new Error(stderr || 'Bridge Python no devolvio datos');
                    emptyError.statusCode = 502;
                    emptyError.code = 'PYTHON_BRIDGE_EMPTY_RESPONSE';
                    logStore.error('zk.bridge.empty-response', {
                        action,
                        stderr
                    });
                    reject(emptyError);
                    return;
                }

                if (code !== 0 || parsed.ok === false) {
                    const bridgeError = new Error(parsed.error?.message || stderr || 'Error ejecutando bridge Python');
                    bridgeError.statusCode = parsed.error?.statusCode || (parsed.error?.code === 'PYZK_NOT_INSTALLED' ? 503 : 502);
                    bridgeError.code = parsed.error?.code || 'ZK_BRIDGE_ERROR';
                    bridgeError.details = parsed;
                    logStore.error('zk.bridge.command-failed', {
                        action,
                        exitCode: code,
                        error: bridgeError.message,
                        code: bridgeError.code
                    });
                    reject(bridgeError);
                    return;
                }

                parsed.durationMs = parsed.durationMs || Number((Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2));
                logStore.info('zk.bridge.command-success', {
                    action,
                    ip: resolved.ip,
                    port: resolved.port
                });
                resolve(parsed);
            });

            child.stdin.write(payload);
            child.stdin.end();
        });
    }

    return {
        async ping(options) {
            return ping(options);
        },

        async connect(options) {
            const tcp = await ping(options);
            const bridge = await runBridge('connect', options);
            return {
                ok: tcp.ok && bridge.ok,
                message: 'Conexion al dispositivo verificada',
                tcp,
                bridge
            };
        },

        async testConnection(options) {
            const tcp = await ping(options);

            try {
                const bridge = await runBridge('connect', options);
                return {
                    ok: tcp.ok && bridge.ok,
                    ip: tcp.ip,
                    port: tcp.port,
                    tcp,
                    bridge
                };
            } catch (error) {
                return {
                    ok: false,
                    ip: tcp.ip,
                    port: tcp.port,
                    tcp,
                    bridge: {
                        ok: false,
                        error: error.message,
                        code: error.code || null
                    }
                };
            }
        },

        async getUsers(options) {
            return runBridge('get-users', options);
        },

        async createUser(options) {
            return runBridge('create-user', options);
        },

        async updateUser(options) {
            return runBridge('update-user', options);
        },

        async deleteUser(options) {
            return runBridge('delete-user', options);
        },

        async getDeviceInfo(options) {
            return runBridge('device-info', options);
        }
    };
}

module.exports = {
    createZkTcpService
};
