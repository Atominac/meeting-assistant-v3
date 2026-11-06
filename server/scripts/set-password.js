// Admin tool (there is no email service for "forgot password" yet):
//   npm -w server run set-password -- someone@example.com 'new password'
import { env } from '../src/env.js';
import { connect, col, close } from '../src/db.js';
import { hashPassword, normEmail, passwordProblem } from '../src/auth.js';

const [email, password] = [normEmail(process.argv[2]), process.argv[3]];
if (!email || !password) { console.error('Usage: set-password <email> <new password>'); process.exit(1); }
const bad = passwordProblem(password);
if (bad) { console.error(bad); process.exit(1); }
await connect(env.mongoUri, env.mongoDb);
const u = await col('users').findOne({ email });
if (!u) { console.error(`No account for ${email}`); await close(); process.exit(1); }
await col('users').updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(password) } });
const out = await col('sessions').deleteMany({ uid: u._id });
console.log(`Password updated for ${email}; signed out ${out.deletedCount} device(s).`);
await close();
