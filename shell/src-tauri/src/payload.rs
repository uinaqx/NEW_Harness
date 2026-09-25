//! Content-addressed payload staging. Never trust a stamp or a neighbouring exe.
use sha2::{Digest, Sha256};
use std::{fs, io::{self, Read, Write}, path::{Path, PathBuf}};

fn digest_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn stage(dir: &Path, bytes: &[u8], extension: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let target = dir.join(format!("harness-backend-{digest}{extension}"));
    if digest_file(&target).ok().as_deref() == Some(&digest) { return Ok(target); }
    let temporary = dir.join(format!(".backend-{}-{}.tmp", std::process::id(), digest));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if digest_file(&temporary)? != digest {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "backend payload digest mismatch"));
        }
        fs::rename(&temporary, &target)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
        }
        Ok(target)
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn verifies_contents_and_never_selects_old_canonical_or_stamp() {
        let dir = std::env::temp_dir().join(format!("harness-payload-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("harness-backend.exe"), b"old").unwrap();
        fs::write(dir.join("harness-backend.stamp.json"), b"corrupt").unwrap();
        let first = stage(&dir, b"new", ".exe").unwrap();
        assert_ne!(first, dir.join("harness-backend.exe"));
        fs::write(&first, b"bad").unwrap(); // same size, different bytes
        assert_eq!(stage(&dir, b"new", ".exe").unwrap(), first);
        assert_eq!(fs::read(&first).unwrap(), b"new");
        fs::write(&first, b"x").unwrap(); // truncated
        stage(&dir, b"new", ".exe").unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"new");
        let next = stage(&dir, b"NEW", ".exe").unwrap();
        assert_ne!(first, next); // same version/size has a separate path
        assert_eq!(stage(&dir, b"NEW", ".exe").unwrap(), next);
        fs::remove_dir_all(dir).unwrap();
    }
}
