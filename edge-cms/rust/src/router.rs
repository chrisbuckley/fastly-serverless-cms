pub enum Route {
    Home,
    Post { slug: String },
    Tag { tag: String },
    Image { path: String },
    Asset { path: String },
    Feed,
    Sitemap,
    Robots,
    AdminLogin,
    AdminLoginPost,
    AdminDashboard,
    AdminNewPost,
    AdminCreatePost,
    AdminEditPost { slug: String },
    AdminUpdatePost { slug: String },
    AdminDeletePost { slug: String },
    AdminUploadImage,
    AdminSidebar,
    AdminUpdateSidebar,
    AdminLogout,
    NotFound,
}

pub fn match_route(method: &str, path: &str) -> Route {
    match (method, path) {
        ("GET", "/") => Route::Home,
        ("GET", "/feed.xml") => Route::Feed,
        ("GET", "/sitemap.xml") => Route::Sitemap,
        ("GET", "/robots.txt") => Route::Robots,
        ("GET", "/admin/login") => Route::AdminLogin,
        ("POST", "/admin/login") => Route::AdminLoginPost,
        ("POST", "/admin/logout") => Route::AdminLogout,
        ("GET", "/admin") => Route::AdminDashboard,
        ("GET", "/admin/posts/new") => Route::AdminNewPost,
        ("POST", "/admin/posts") => Route::AdminCreatePost,
        ("GET", "/admin/sidebar") => Route::AdminSidebar,
        ("PUT", "/admin/sidebar") => Route::AdminUpdateSidebar,
        ("POST", "/admin/images") => Route::AdminUploadImage,
        ("GET", p) => {
            if let Some(slug) = p.strip_prefix("/post/") {
                Route::Post {
                    slug: slug.to_string(),
                }
            } else if let Some(tag) = p.strip_prefix("/tag/") {
                Route::Tag {
                    tag: tag.to_string(),
                }
            } else if let Some(path) = p.strip_prefix("/images/") {
                Route::Image {
                    path: path.to_string(),
                }
            } else if let Some(path) = p.strip_prefix("/assets/") {
                Route::Asset {
                    path: path.to_string(),
                }
            } else if p.starts_with("/admin/posts/") && p.ends_with("/edit") {
                let slug = p
                    .strip_prefix("/admin/posts/")
                    .unwrap()
                    .strip_suffix("/edit")
                    .unwrap()
                    .to_string();
                Route::AdminEditPost { slug }
            } else {
                Route::NotFound
            }
        }
        ("PUT", p) if p.starts_with("/admin/posts/") => Route::AdminUpdatePost {
            slug: p.strip_prefix("/admin/posts/").unwrap().to_string(),
        },
        ("DELETE", p) if p.starts_with("/admin/posts/") => Route::AdminDeletePost {
            slug: p.strip_prefix("/admin/posts/").unwrap().to_string(),
        },
        _ => Route::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_home() {
        assert!(matches!(match_route("GET", "/"), Route::Home));
    }

    #[test]
    fn route_post() {
        match match_route("GET", "/post/hello-world") {
            Route::Post { slug } => assert_eq!(slug, "hello-world"),
            other => panic!("expected Post, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_tag() {
        match match_route("GET", "/tag/rust") {
            Route::Tag { tag } => assert_eq!(tag, "rust"),
            other => panic!("expected Tag, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_image() {
        match match_route("GET", "/images/hero.jpg") {
            Route::Image { path } => assert_eq!(path, "hero.jpg"),
            other => panic!("expected Image, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_asset() {
        match match_route("GET", "/assets/style.css") {
            Route::Asset { path } => assert_eq!(path, "style.css"),
            other => panic!("expected Asset, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_feed() {
        assert!(matches!(match_route("GET", "/feed.xml"), Route::Feed));
    }

    #[test]
    fn route_sitemap() {
        assert!(matches!(match_route("GET", "/sitemap.xml"), Route::Sitemap));
    }

    #[test]
    fn route_robots() {
        assert!(matches!(match_route("GET", "/robots.txt"), Route::Robots));
    }

    #[test]
    fn route_admin_login() {
        assert!(matches!(
            match_route("GET", "/admin/login"),
            Route::AdminLogin
        ));
        assert!(matches!(
            match_route("POST", "/admin/login"),
            Route::AdminLoginPost
        ));
    }

    #[test]
    fn route_admin_dashboard() {
        assert!(matches!(
            match_route("GET", "/admin"),
            Route::AdminDashboard
        ));
    }

    #[test]
    fn route_admin_new_post() {
        assert!(matches!(
            match_route("GET", "/admin/posts/new"),
            Route::AdminNewPost
        ));
    }

    #[test]
    fn route_admin_create_post() {
        assert!(matches!(
            match_route("POST", "/admin/posts"),
            Route::AdminCreatePost
        ));
    }

    #[test]
    fn route_admin_edit_post() {
        match match_route("GET", "/admin/posts/hello-world/edit") {
            Route::AdminEditPost { slug } => assert_eq!(slug, "hello-world"),
            other => panic!("expected AdminEditPost, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_admin_update_post() {
        match match_route("PUT", "/admin/posts/hello-world") {
            Route::AdminUpdatePost { slug } => assert_eq!(slug, "hello-world"),
            other => panic!("expected AdminUpdatePost, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_admin_delete_post() {
        match match_route("DELETE", "/admin/posts/hello-world") {
            Route::AdminDeletePost { slug } => assert_eq!(slug, "hello-world"),
            other => panic!("expected AdminDeletePost, got {:?}", route_name(&other)),
        }
    }

    #[test]
    fn route_admin_upload_image() {
        assert!(matches!(
            match_route("POST", "/admin/images"),
            Route::AdminUploadImage
        ));
    }

    #[test]
    fn route_admin_sidebar() {
        assert!(matches!(
            match_route("GET", "/admin/sidebar"),
            Route::AdminSidebar
        ));
        assert!(matches!(
            match_route("PUT", "/admin/sidebar"),
            Route::AdminUpdateSidebar
        ));
    }

    #[test]
    fn route_admin_logout() {
        assert!(matches!(
            match_route("POST", "/admin/logout"),
            Route::AdminLogout
        ));
    }

    #[test]
    fn route_not_found() {
        assert!(matches!(
            match_route("GET", "/nonexistent"),
            Route::NotFound
        ));
        assert!(matches!(
            match_route("POST", "/nonexistent"),
            Route::NotFound
        ));
        assert!(matches!(
            match_route("PATCH", "/admin/posts/foo"),
            Route::NotFound
        ));
    }

    /// Helper to get a printable name for a route variant (since we
    /// don't derive Debug on Route to keep it lightweight).
    fn route_name(route: &Route) -> &'static str {
        match route {
            Route::Home => "Home",
            Route::Post { .. } => "Post",
            Route::Tag { .. } => "Tag",
            Route::Image { .. } => "Image",
            Route::Asset { .. } => "Asset",
            Route::Feed => "Feed",
            Route::Sitemap => "Sitemap",
            Route::Robots => "Robots",
            Route::AdminLogin => "AdminLogin",
            Route::AdminLoginPost => "AdminLoginPost",
            Route::AdminDashboard => "AdminDashboard",
            Route::AdminNewPost => "AdminNewPost",
            Route::AdminCreatePost => "AdminCreatePost",
            Route::AdminEditPost { .. } => "AdminEditPost",
            Route::AdminUpdatePost { .. } => "AdminUpdatePost",
            Route::AdminDeletePost { .. } => "AdminDeletePost",
            Route::AdminUploadImage => "AdminUploadImage",
            Route::AdminSidebar => "AdminSidebar",
            Route::AdminUpdateSidebar => "AdminUpdateSidebar",
            Route::AdminLogout => "AdminLogout",
            Route::NotFound => "NotFound",
        }
    }
}
