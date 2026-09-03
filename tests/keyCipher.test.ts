import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  decryptWithKeyAuto,
  encryptWithKeyCbc,
  encryptWithKeyGcm,
} from '../server/keyCipher';

const key = crypto.randomBytes(32);
const wrongKey = crypto.randomBytes(32);

describe('keyCipher · GCM（v2 现行）', () => {
  it('加解密往返', () => {
    const cipher = encryptWithKeyGcm(key, 'sk-my-secret-key-123');
    expect(cipher.startsWith('gcm:')).toBe(true);
    expect(decryptWithKeyAuto(key, cipher)).toBe('sk-my-secret-key-123');
  });

  it('密文被篡改 → 认证失败返回空（不解出垃圾密钥）', () => {
    const cipher = encryptWithKeyGcm(key, 'sk-my-secret-key-123');
    const parts = cipher.split(':');
    const ct = Buffer.from(parts[3], 'hex');
    ct[0] = ct[0] ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${ct.toString('hex')}`;
    expect(decryptWithKeyAuto(key, tampered)).toBe('');
  });

  it('错误密钥 → 认证失败返回空（异机不可解）', () => {
    const cipher = encryptWithKeyGcm(key, 'secret');
    expect(decryptWithKeyAuto(wrongKey, cipher)).toBe('');
  });

  it('随机 IV：同一明文两次加密密文不同', () => {
    expect(encryptWithKeyGcm(key, 'x')).not.toBe(encryptWithKeyGcm(key, 'x'));
  });
});

describe('keyCipher · CBC 兼容读（v1 历史密文）', () => {
  it('旧格式密文可解（迁移兜底）', () => {
    const legacy = encryptWithKeyCbc(key, 'sk-legacy-key');
    expect(legacy.startsWith('gcm:')).toBe(false);
    expect(decryptWithKeyAuto(key, legacy)).toBe('sk-legacy-key');
  });

  it('旧格式密文用错误密钥 → 返回空', () => {
    const legacy = encryptWithKeyCbc(key, 'sk-legacy-key');
    expect(decryptWithKeyAuto(wrongKey, legacy)).toBe('');
  });
});

describe('keyCipher · 异常输入', () => {
  it('空串 / 垃圾 / 缺段 → 返回空不抛错', () => {
    expect(decryptWithKeyAuto(key, '')).toBe('');
    expect(decryptWithKeyAuto(key, 'not-a-cipher')).toBe('');
    expect(decryptWithKeyAuto(key, 'gcm:onlytwo')).toBe('');
    expect(decryptWithKeyAuto(key, 'gcm:zz:yy:xx')).toBe('');
  });
});
