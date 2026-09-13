import { Router } from 'express';
import { config } from '../config.js';

const r = Router();
r.get('/health', (req, res) => res.json({ ok: true, version: config.version, dataDir: config.dataDir }));
export default r;
