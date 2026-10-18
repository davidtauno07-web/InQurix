import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';

const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
const esc = (s: string) => s.trim().replace(/\n/g, '\\n');
console.log(`ENTITLEMENT_PRIVATE_KEY="${esc(await exportPKCS8(privateKey))}"`);
console.log(`ENTITLEMENT_PUBLIC_KEY="${esc(await exportSPKI(publicKey))}"`);
