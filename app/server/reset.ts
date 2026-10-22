import { join } from 'node:path';
import { openDb } from './db.ts';

const root = join(import.meta.dirname, '..');
const db = openDb(join(root, 'data', 'fiesta.db'), join(root, 'data', 'guests.csv'));
db.exec('DELETE FROM attempt; DELETE FROM registration;');
console.log('Registrations and attempts deleted. Roster kept.');
