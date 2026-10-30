export interface Pagination {
  page: number;
  total_pages: number;
  prev_url: string | null;
  next_url: string | null;
}

export interface Page<T> {
  items: T[];
  pagination: Pagination;
}

export function paginate<T>(
  all: T[],
  pageParam: string | null,
  pageSize: number,
  basePath: string,
): Page<T> | null {
  const size = pageSize > 0 ? pageSize : 10;
  const totalPages = Math.max(1, Math.ceil(all.length / size));

  let page = 1;
  if (pageParam !== null) {
    if (!/^[0-9]+$/.test(pageParam)) return null;
    page = parseInt(pageParam, 10);
  }
  if (page < 1 || page > totalPages) return null;

  const link = (n: number): string => `${basePath}?page=${n}`;
  return {
    items: all.slice((page - 1) * size, page * size),
    pagination: {
      page,
      total_pages: totalPages,
      prev_url: page > 1 ? link(page - 1) : null,
      next_url: page < totalPages ? link(page + 1) : null,
    },
  };
}
