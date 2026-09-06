// @vitest-environment node
/** Cloud-sync root detection (cloud-roots.ts): pure classifier over injected inputs. */
import { describe, it, expect } from 'vitest';
import { classifyCloudPath, type CloudEnv } from '../../apps/desktop/src/cloud-roots.js';

const mac: CloudEnv = {
  platform: 'darwin',
  home: '/Users/ant',
  env: {},
  dropboxInfo: { personal: { path: '/Users/ant/Dropbox (Personal)' }, business: { path: '/Users/ant/Dropbox (Team)' } },
};
const win: CloudEnv = {
  platform: 'win32',
  home: 'C:\\Users\\ant',
  env: { OneDrive: 'C:\\Users\\ant\\OneDrive', OneDriveCommercial: 'C:\\Users\\ant\\OneDrive - School' },
  dropboxInfo: { personal: { path: 'C:\\Users\\ant\\Dropbox' } },
};

describe('classifyCloudPath', () => {
  it('matches Dropbox roots from info.json (both accounts) and the legacy ~/Dropbox', () => {
    expect(classifyCloudPath('/Users/ant/Dropbox (Personal)/Debate/Aff.cmir', mac)).toBe('dropbox');
    expect(classifyCloudPath('/Users/ant/Dropbox (Team)/x.cmir', mac)).toBe('dropbox');
    expect(classifyCloudPath('/Users/ant/Dropbox/x.cmir', { ...mac, dropboxInfo: null })).toBe('dropbox');
    expect(classifyCloudPath('/Users/ant/Dropbox (Personal)', mac), 'the root itself is not inside').toBeNull();
  });

  it('macOS File Provider mounts and iCloud Drive', () => {
    expect(classifyCloudPath('/Users/ant/Library/CloudStorage/Dropbox-Team/x.cmir', mac)).toBe('dropbox');
    expect(classifyCloudPath('/Users/ant/Library/CloudStorage/OneDrive-Dartmouth/x.cmir', mac)).toBe('onedrive');
    expect(classifyCloudPath('/Users/ant/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/x.cmir', mac)).toBe('gdrive');
    expect(classifyCloudPath('/Users/ant/Library/CloudStorage/Box-Box/x.cmir', mac)).toBe('other');
    expect(classifyCloudPath('/Users/ant/Library/Mobile Documents/com~apple~CloudDocs/x.cmir', mac)).toBe('icloud');
  });

  it('Windows OneDrive env roots and Google Drive letter mounts', () => {
    expect(classifyCloudPath('C:\\Users\\ant\\OneDrive\\Debate\\x.cmir', win)).toBe('onedrive');
    expect(classifyCloudPath('C:\\Users\\ant\\OneDrive - School\\x.cmir', win)).toBe('onedrive');
    expect(classifyCloudPath('G:\\My Drive\\Debate\\x.cmir', win)).toBe('gdrive');
    expect(classifyCloudPath('G:\\Shared drives\\Team\\x.cmir', win)).toBe('gdrive');
    expect(classifyCloudPath('C:\\Users\\ant\\Dropbox\\x.cmir', win)).toBe('dropbox');
  });

  it('a local file is null', () => {
    expect(classifyCloudPath('/Users/ant/Documents/x.cmir', mac)).toBeNull();
    expect(classifyCloudPath('C:\\Users\\ant\\Documents\\x.cmir', win)).toBeNull();
    expect(classifyCloudPath('/Users/ant/DropboxNotReally/x.cmir', { ...mac, dropboxInfo: null }), 'prefix, not substring').toBeNull();
  });
});
