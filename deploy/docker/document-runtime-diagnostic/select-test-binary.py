#!/usr/bin/env python3
"""Select one Cargo lib-test executable; never guess/glob an arbitrary binary."""
import hashlib, json, pathlib, shutil, subprocess, sys
FILTER = 'systemd_driver::container_diagnostic::fixed_sleep_unit_times_out'
def select(lines):
    found=[]
    for line in lines:
        item=json.loads(line)
        if (item.get('reason')=='compiler-artifact' and item.get('target',{}).get('name')=='dyoffice_document_broker'
            and item.get('target',{}).get('kind')==['lib'] and item.get('profile',{}).get('test') is True and item.get('executable')):
            found.append(item['executable'])
    if len(found)!=1: raise ValueError('expected one locked library test binary')
    return pathlib.Path(found[0])
def main(args):
    if len(args)!=2: raise ValueError('expected cargo JSON and output directory')
    path=select(pathlib.Path(args[0]).read_text().splitlines()).resolve(strict=True)
    if not path.is_relative_to('/build/services/document-broker/target') or not path.is_file(): raise ValueError('unexpected artifact path')
    listing=subprocess.run([str(path),FILTER,'--list','--exact'],check=True,capture_output=True,text=True,timeout=10).stdout
    if FILTER+': test' not in listing or '1 test,' not in listing: raise ValueError('required diagnostic test absent')
    out=pathlib.Path(args[1]);out.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(path,out/'probe');(out/'probe').chmod(0o555)
    digest=hashlib.sha256((out/'probe').read_bytes()).hexdigest()
    (out/'probe.sha256').write_text(digest+'  probe\n')
if __name__=='__main__': main(sys.argv[1:])
