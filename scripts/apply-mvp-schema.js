const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
  const sqlPath = path.resolve(process.cwd(), 'MYSQL_MVP_LIMPIO_DESDE_CERO.sql');

  if (!fs.existsSync(sqlPath)) {
    throw new Error(`No existe el archivo SQL: ${sqlPath}`);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');

  const connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    port: Number(process.env.MYSQL_PORT || 3306),
    multipleStatements: true
  });

  await connection.query(sql);
  await connection.end();

  console.log('Schema MVP limpio aplicado correctamente');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});