import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('release gates preserve exact bytes and per-file signatures without requiring one certificate across signing rounds',async()=>{
  const build=await readFile('scripts/build-windows-installer.ps1','utf8');
  const verify=await readFile('scripts/verify-windows-release.ps1','utf8');
  assert.doesNotMatch(build,/Mixed owner signing certificates|\$signer -ne/);
  assert.doesNotMatch(verify,/Outer signer differs|\$item\.thumbprint -ne \$sig\.SignerCertificate/);
  for(const source of [build,verify]){
    assert.match(source,/TimeStamperCertificate/);assert.match(source,/SignerCertificate/);
    assert.match(source,/normalized/);assert.match(source,/sha256/);
  }
  assert.match(verify,/Installed file signer differs from its frozen payload/);
});

test('desktop validates official release metadata anew and both update stages retain signature gates without a pin',async()=>{
  const host=await readFile('src/desktop/Cloudig.Desktop/MainWindow.UpdateInstallation.cs','utf8');
  const prepare=await readFile('src/desktop/Cloudig.Desktop.Core/PortableUpdateClient.cs','utf8');
  const helper=await readFile('src/desktop/Cloudig.Desktop.Core/PortableUpdate.ps1','utf8');
  assert.match(host,/ExactProperties\(request\.Payload\)/);
  assert.match(host,/_releaseUpdates\.CheckAsync\(ProductVersion, token\)/);
  assert.match(prepare,/ReleaseUpdateClient\.RepositoryUrl/);
  for(const source of [prepare,helper]){assert.doesNotMatch(source,/PublisherThumbprint|0742580B8EA12653FE3A1E906613268467BAD80A/);assert.match(source,/TimeStamperCertificate/);assert.match(source,/SignerCertificate/);}
  assert.match(helper,/\$request\.Sha256/);
});
