// Keep independently prepared photographic manifests intact.
import { PHOTO_ARCHIVE as PILOT } from './photo-archive.js?v=12.4';
import { PHOTO_ARCHIVE_A } from './photo-archive-a.js?v=12.4';
import { PHOTO_ARCHIVE_B } from './photo-archive-b.js?v=12.4';
import { ARCHIVE_LARGE } from './archive-large.js?v=12.4';

const sources = { ...PILOT, ...PHOTO_ARCHIVE_A, ...PHOTO_ARCHIVE_B };
export const PHOTO_ARCHIVE = Object.freeze(Object.fromEntries(Object.entries(sources).map(([id, records]) => [id, records.map(p => ({ ...p, ...ARCHIVE_LARGE[p.full] }))])));
