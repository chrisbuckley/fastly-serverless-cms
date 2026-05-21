use std::env;
use std::fs;
use std::path::Path;

fn copy_dir_recursive(src: &Path, dst: &Path) {
    if !dst.exists() {
        fs::create_dir_all(dst).unwrap();
    }
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path);
        } else {
            fs::copy(&src_path, &dst_path).unwrap();
        }
    }
}

fn main() {
    let out_dir = env::var("OUT_DIR").unwrap();
    let shared_dir = Path::new("../shared");

    let templates_dst = Path::new(&out_dir).join("templates");
    let css_dst = Path::new(&out_dir).join("css");
    let js_dst = Path::new(&out_dir).join("js");

    copy_dir_recursive(&shared_dir.join("templates"), &templates_dst);
    copy_dir_recursive(&shared_dir.join("css"), &css_dst);
    copy_dir_recursive(&shared_dir.join("js"), &js_dst);

    println!("cargo:rerun-if-changed=../shared/templates");
    println!("cargo:rerun-if-changed=../shared/css");
    println!("cargo:rerun-if-changed=../shared/js");
}
