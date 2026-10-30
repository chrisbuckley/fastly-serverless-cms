//! `?page=N` pagination for home and tag listings (contract §10).

use serde_json::{json, Value};

#[derive(Debug, PartialEq, Eq)]
pub struct Page {
    pub page: usize,
    pub total_pages: usize,
    pub start: usize,
    pub end: usize,
}

/// `None` means 404: unparsable, zero, or beyond the last page. An empty list
/// still has one (empty) page.
pub fn paginate(total_items: usize, page_size: usize, requested: Option<&str>) -> Option<Page> {
    let page_size = page_size.max(1);
    let page = match requested {
        None => 1,
        Some(raw) => raw.parse::<usize>().ok().filter(|&p| p >= 1)?,
    };
    let total_pages = total_items.div_ceil(page_size).max(1);
    if page > total_pages {
        return None;
    }
    let start = (page - 1) * page_size;
    Some(Page {
        page,
        total_pages,
        start,
        end: (start + page_size).min(total_items),
    })
}

/// Canonical URL of page `n` under `base` (`/` or `/tag/x`); page 1 is the bare base.
pub fn canonical_path(base: &str, n: usize) -> String {
    if n <= 1 {
        base.to_string()
    } else {
        format!("{base}?page={n}")
    }
}

/// Prev/next links always carry `?page=N`, including page 1.
pub fn to_json(base: &str, p: &Page) -> Value {
    let link = |n: usize| format!("{base}?page={n}");
    json!({
        "page": p.page,
        "total_pages": p.total_pages,
        "prev_url": (p.page > 1).then(|| link(p.page - 1)),
        "next_url": (p.page < p.total_pages).then(|| link(p.page + 1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_page_default() {
        assert_eq!(
            paginate(25, 10, None),
            Some(Page {
                page: 1,
                total_pages: 3,
                start: 0,
                end: 10
            })
        );
    }

    #[test]
    fn last_partial_page() {
        assert_eq!(
            paginate(25, 10, Some("3")),
            Some(Page {
                page: 3,
                total_pages: 3,
                start: 20,
                end: 25
            })
        );
    }

    #[test]
    fn out_of_range_and_garbage_is_none() {
        assert_eq!(paginate(25, 10, Some("4")), None);
        assert_eq!(paginate(25, 10, Some("0")), None);
        assert_eq!(paginate(25, 10, Some("-1")), None);
        assert_eq!(paginate(25, 10, Some("abc")), None);
        assert_eq!(paginate(25, 10, Some("")), None);
    }

    #[test]
    fn empty_list_has_one_page() {
        assert_eq!(paginate(0, 10, None).unwrap().total_pages, 1);
        assert_eq!(paginate(0, 10, Some("2")), None);
    }

    #[test]
    fn exact_multiple() {
        assert_eq!(paginate(20, 10, None).unwrap().total_pages, 2);
    }

    #[test]
    fn json_links() {
        let p = paginate(25, 10, Some("2")).unwrap();
        assert_eq!(
            to_json("/", &p),
            json!({"page": 2, "total_pages": 3, "prev_url": "/?page=1", "next_url": "/?page=3"})
        );
        let p = paginate(25, 10, None).unwrap();
        assert_eq!(
            to_json("/tag/x", &p),
            json!({"page": 1, "total_pages": 3, "prev_url": null, "next_url": "/tag/x?page=2"})
        );
        let p = paginate(25, 10, Some("3")).unwrap();
        assert_eq!(to_json("/", &p)["next_url"], Value::Null);
        assert_eq!(to_json("/", &p)["prev_url"], "/?page=2");
    }

    #[test]
    fn canonical_path_page_one_is_bare() {
        assert_eq!(canonical_path("/", 1), "/");
        assert_eq!(canonical_path("/tag/x", 2), "/tag/x?page=2");
    }
}
