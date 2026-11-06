import { MongoClient } from 'mongodb';
import { env } from './env.js';

let client;
export let db;

export async function connect(uri = env.mongoUri, name = env.mongoDb) {
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  db = client.db(name);
  await Promise.all([
    db.collection('meetings').createIndex({ uid: 1, startedAt: -1 }),
    db.collection('meetings').createIndex({ status: 1 }),
    db.collection('meetings').createIndex({ uploadId: 1 }),
    db.collection('uploads').createIndex({ token: 1 }, { unique: true }),
    db.collection('upload_events').createIndex({ uploadId: 1, relative: 1 }),
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ uid: 1 }),
    db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection('calendar_events').createIndex({ uid: 1, start: 1 }),
    db.collection('calendar_accounts').createIndex({ uid: 1 }, { unique: true }),
  ]);
  return db;
}

export const col = (name) => db.collection(name);
export const close = () => client?.close();
