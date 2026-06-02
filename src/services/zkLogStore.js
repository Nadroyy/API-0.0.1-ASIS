const fs = require('fs');

function createZkLogStore({ filePath, maxEntries = 200 }) {
    const entries = [];

    function push(level, event, details) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            event,
            details: details || {}
        };

        entries.unshift(entry);
        if (entries.length > maxEntries) {
            entries.pop();
        }

        if (filePath) {
            const line = `${entry.timestamp} [${level.toUpperCase()}] ${event} ${JSON.stringify(entry.details)}\n`;
            fs.appendFile(filePath, line, () => {});
        }

        return entry;
    }

    return {
        info(event, details) {
            return push('info', event, details);
        },
        warn(event, details) {
            return push('warn', event, details);
        },
        error(event, details) {
            return push('error', event, details);
        },
        getEntries(limit = 50) {
            return entries.slice(0, limit);
        }
    };
}

module.exports = {
    createZkLogStore
};
