import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Exact owned CA registration; no certificate-verification bypass. */
export class TlsTestOwner {
  constructor(resources, directory) {
    this.resources = resources;
    this.directory = directory;
    this.ledger = resources.data.tls = {
      directory,
      nickname: 'lab-word-wss-' + resources.data.runId,
      database: join(homedir(), '.pki', 'nssdb'),
      state: 'planned',
    };
    resources.save();
  }
  async prepare() {
    if (process.platform !== 'linux')
      throw new Error('Trusted Chromium TLS supervisor supports Linux');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tools = join(this.directory, 'tools');
    mkdirSync(tools, { mode: 0o700 });
    let certutil = process.env.LAB_WORD_TEST_CERTUTIL;
    if (!certutil) {
      try {
        certutil = run('which', ['certutil']).trim();
      } catch {
        // Extract only into this run's tools; do not change installed system packages.
        run('apt-get', ['download', 'libnss3-tools'], tools);
        const deb = readdirSync(tools).find((name) =>
          /^libnss3-tools_.*\.deb$/.test(name),
        );
        if (!deb)
          throw new Error('No owned libnss3-tools archive was downloaded');
        run('dpkg-deb', ['--extract', join(tools, deb), tools]);
        certutil = join(tools, 'usr', 'bin', 'certutil');
      }
    }
    this.ledger.certutil = certutil;
    this.ledger.databaseExisted = existsSync(
      join(this.ledger.database, 'cert9.db'),
    );
    this.resources.save();
    const rootKey = join(this.directory, 'ca.key'),
      ca = join(this.directory, 'ca.pem');
    const key = join(this.directory, 'server.key'),
      csr = join(this.directory, 'server.csr');
    const cert = join(this.directory, 'server.pem'),
      ext = join(this.directory, 'server.ext');
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=' + this.ledger.nickname,
      '-keyout',
      rootKey,
      '-out',
      ca,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    run('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-subj',
      '/CN=localhost',
      '-keyout',
      key,
      '-out',
      csr,
    ]);
    chmodSync(rootKey, 0o600);
    chmodSync(key, 0o600);
    writeFileSync(
      ext,
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
    );
    run('openssl', [
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      ca,
      '-CAkey',
      rootKey,
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '1',
      '-sha256',
      '-extfile',
      ext,
    ]);
    this.ledger.fingerprint = run('openssl', [
      'x509',
      '-in',
      ca,
      '-noout',
      '-fingerprint',
      '-sha256',
    ]).trim();
    Object.assign(this.ledger, { ca, cert, key });
    mkdirSync(this.ledger.database, { recursive: true, mode: 0o700 });
    if (!this.ledger.databaseExisted)
      run(certutil, [
        '-N',
        '-d',
        'sql:' + this.ledger.database,
        '--empty-password',
      ]);
    this.ledger.baseline = run(certutil, [
      '-L',
      '-d',
      'sql:' + this.ledger.database,
    ]);
    this.ledger.state = 'registering';
    this.resources.save();
    run(certutil, [
      '-A',
      '-d',
      'sql:' + this.ledger.database,
      '-n',
      this.ledger.nickname,
      '-t',
      'CT,,',
      '-i',
      ca,
    ]);
    this.ledger.state = 'trusted';
    this.resources.save();
    return { ca, cert, key };
  }
  cleanup() {
    const row = this.ledger;
    if (['registering', 'trusted'].includes(row.state)) {
      // Re-prove exact public certificate identity before changing shared trust.
      let registered;
      const actual = run(row.certutil, ['-L', '-d', 'sql:' + row.database]);
      if (new RegExp('^' + row.nickname + '\\s+', 'm').test(actual))
        registered = run(row.certutil, [
          '-L',
          '-d',
          'sql:' + row.database,
          '-n',
          row.nickname,
          '-a',
        ]);
      if (registered) {
        const exported = join(this.directory, 'registered.pem');
        writeFileSync(exported, registered);
        const fingerprint = run('openssl', [
          'x509',
          '-in',
          exported,
          '-noout',
          '-fingerprint',
          '-sha256',
        ]).trim();
        if (fingerprint !== row.fingerprint)
          throw new Error('Owned CA identity changed; trust preserved');
        run(row.certutil, [
          '-D',
          '-d',
          'sql:' + row.database,
          '-n',
          row.nickname,
        ]);
      }
      row.after = run(row.certutil, ['-L', '-d', 'sql:' + row.database]);
      row.baselineChanged = row.after !== row.baseline;
      row.state = 'trust-removed';
      this.resources.save();
    }
    // Preserve shared NSS stores, even ones first created during this run.
    rmSync(this.directory, { recursive: true, force: true });
    row.state = 'cleaned';
    this.resources.save();
  }
  static recover(resources) {
    const row = resources.data.tls;
    if (!row || row.state === 'cleaned') return;
    const owner = Object.create(TlsTestOwner.prototype);
    Object.assign(owner, { resources, directory: row.directory, ledger: row });
    owner.cleanup();
  }
}
