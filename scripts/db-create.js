// Creates the database named in DB_NAME if it does not exist yet.
import pg from "pg";
import { env } from "../src/config/env.js";
import { dbConfig } from "../src/db/pool.js";

const client = new pg.Client(dbConfig("postgres"));
await client.connect();
const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [env.DB_NAME]);
if (rowCount) {
  console.log(`Database "${env.DB_NAME}" already exists`);
} else {
  // Identifier can't be parameterised; DB_NAME comes from our own .env, but keep it to a safe charset anyway
  if (!/^[a-z0-9_]+$/i.test(env.DB_NAME)) throw new Error("DB_NAME may only contain letters, digits and _");
  await client.query(`CREATE DATABASE "${env.DB_NAME}" ENCODING 'UTF8' TEMPLATE template0`);
  console.log(`Created database "${env.DB_NAME}"`);
}
await client.end();
