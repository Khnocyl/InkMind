/**
 * API Key 加密原语（纯函数，无文件/环境副作用，可单测）：
 * - v2（现行）：aes-256-gcm，格式 `gcm:<iv>:<tag>:<ct>`——带认证标签，
 *   密文被篡改时解密失败而非解出垃圾密钥发给上游（安全审计 P3-1）。
 * - v1（兼容读）：aes-256-cbc，格式 `<iv>:<ct>`——历史密文仍可解，
 *   由 llmService 的启动迁移一次性升级为 GCM 重加密落盘。
 */
import crypto from 'crypto';

const GCM_PREFIX = 'gcm:';
const GCM_IV_BYTES = 12;

/** GCM 加密：输出 `gcm:<ivHex>:<tagHex>:<ctHex>` */
export function encryptWithKeyGcm(key: Buffer, plainText: string): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    `${GCM_PREFIX}${iv.toString('hex')}:` +
    `${tag.toString('hex')}:${ct.toString('hex')}`
  );
}

/** 旧版 CBC 加密：输出 `<ivHex>:<ctHex>`（仅迁移与兼容测试使用） */
export function encryptWithKeyCbc(key: Buffer, plainText: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plainText, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

/** 解密 CBC 密文（失败返回 ''） */
function decryptCbc(key: Buffer, cipherTextWithIv: string): string {
  if (!cipherTextWithIv.includes(':')) return '';
  try {
    const [ivHex, encryptedHex] = cipherTextWithIv.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf-8');
    decrypted += decipher.final('utf-8');
    return decrypted;
  } catch {
    return '';
  }
}

/**
 * 自动格式解密：`gcm:` 前缀走 GCM（认证失败/密钥不符返回 ''），
 * 否则按旧版 CBC 尝试。任何失败都返回 ''，不抛错。
 */
export function decryptWithKeyAuto(key: Buffer, cipherText: string): string {
  if (!cipherText) return '';
  if (cipherText.startsWith(GCM_PREFIX)) {
    try {
      const [ivHex, tagHex, ctHex] = cipherText
        .slice(GCM_PREFIX.length)
        .split(':');
      if (!ivHex || !tagHex || !ctHex) return '';
      const iv = Buffer.from(ivHex, 'hex');
      if (iv.length !== GCM_IV_BYTES) return '';
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(ctHex, 'hex')),
        decipher.final(),
      ]);
      return plain.toString('utf-8');
    } catch {
      return ''; // 认证标签不符（篡改/异机）→ 拒绝
    }
  }
  return decryptCbc(key, cipherText);
}
