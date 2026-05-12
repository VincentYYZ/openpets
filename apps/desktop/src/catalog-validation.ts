export interface CatalogV2 {
  readonly version: 2;
  readonly generatedAt: string;
  readonly pets: readonly CatalogPetV2[];
}

export interface CatalogPetV2 {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly preview: string;
  readonly zip: string;
}

export interface CatalogV3Index {
  readonly version: 3;
  readonly generatedAt: string;
  readonly total: number;
  readonly pageSize: number;
  readonly filters: { readonly categories: readonly CatalogV3Category[] };
  readonly pages: readonly string[];
}

export interface CatalogV3Category {
  readonly id: "western" | "asian";
  readonly label: string;
  readonly count: number;
}

export interface CatalogV3Page {
  readonly version: 3;
  readonly generatedAt: string;
  readonly page: number;
  readonly pageSize: number;
  readonly pets: readonly CatalogPetV3[];
}

export interface CatalogPetV3 {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly thumbnail: string;
  readonly preview?: string;
  readonly spritesheet?: string;
  readonly zip: string;
  readonly category: "western" | "asian";
  readonly subcategory?: string;
}

export function validateCatalogV2(value: unknown): CatalogV2 {
  if (!isRecord(value)) throw new Error("Catalog must be an object.");
  if (value.version !== 2) throw new Error("Catalog version must be 2.");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) throw new Error("Catalog generatedAt must be a valid date string.");
  if (!Array.isArray(value.pets)) throw new Error("Catalog pets must be an array.");
  if (value.pets.length > 1000) throw new Error("Catalog has too many pets.");

  const ids = new Set<string>();
  const pets = value.pets.map((pet) => validateCatalogPet(pet, ids));

  return {
    version: 2,
    generatedAt: value.generatedAt,
    pets,
  };
}

export function validateCatalogV3Index(value: unknown): CatalogV3Index {
  if (!isRecord(value)) throw new Error("Catalog v3 index must be an object.");
  if (value.version !== 3) throw new Error("Catalog index version must be 3.");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) throw new Error("Catalog generatedAt must be a valid date string.");
  const total = value.total;
  const pageSize = value.pageSize;
  if (!Number.isSafeInteger(total) || typeof total !== "number" || total < 0 || total > 20_000) throw new Error("Catalog total is invalid.");
  if (!Number.isSafeInteger(pageSize) || typeof pageSize !== "number" || pageSize <= 0 || pageSize > 200) throw new Error("Catalog pageSize is invalid.");
  if (!Array.isArray(value.pages) || value.pages.length > 100) throw new Error("Catalog pages are invalid.");
  const pages = value.pages.map((page, index) => validateCatalogPageUrl(page, index));
  const filters = validateCatalogV3Filters(value.filters);
  if (pages.length !== Math.ceil(total / pageSize)) throw new Error("Catalog page count does not match total/pageSize.");
  if (filters.categories.reduce((sum, category) => sum + category.count, 0) !== total) throw new Error("Catalog category counts do not match total.");
  return { version: 3, generatedAt: value.generatedAt, total, pageSize, filters, pages };
}

export function validateCatalogV3Page(value: unknown, expectedPage: number, expectedPageSize: number): CatalogV3Page {
  if (!isRecord(value)) throw new Error("Catalog v3 page must be an object.");
  if (value.version !== 3) throw new Error("Catalog page version must be 3.");
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) throw new Error("Catalog page generatedAt must be a valid date string.");
  if (value.page !== expectedPage) throw new Error("Catalog page index does not match requested page.");
  if (value.pageSize !== expectedPageSize) throw new Error("Catalog page size does not match index.");
  if (!Array.isArray(value.pets) || value.pets.length > expectedPageSize) throw new Error("Catalog page pets are invalid.");
  const ids = new Set<string>();
  const pets = value.pets.map((pet) => validateCatalogPetV3(pet, ids));
  return { version: 3, generatedAt: value.generatedAt, page: expectedPage, pageSize: expectedPageSize, pets };
}

function validateCatalogPet(value: unknown, ids: Set<string>): CatalogPetV2 {
  if (!isRecord(value)) throw new Error("Catalog pet must be an object.");
  const id = validateId(value.id);

  if (ids.has(id)) throw new Error(`Duplicate catalog pet id: ${id}`);
  ids.add(id);

  return {
    id,
    displayName: validateString(value.displayName, "displayName", 120),
    description: validateString(value.description, "description", 500),
    preview: validateCatalogUrl(value.preview, "preview"),
    zip: validateCatalogUrl(value.zip, "zip"),
  };
}

function validateCatalogPetV3(value: unknown, ids: Set<string>): CatalogPetV3 {
  if (!isRecord(value)) throw new Error("Catalog v3 pet must be an object.");
  const id = validateId(value.id);
  if (ids.has(id)) throw new Error(`Duplicate catalog v3 pet id on page: ${id}`);
  ids.add(id);
  const category = validateCategory(value.category);
  const pet: CatalogPetV3 = {
    id,
    displayName: validateString(value.displayName, "displayName", 120),
    description: validateString(value.description, "description", 500),
    thumbnail: validateCatalogUrl(value.thumbnail, "thumbnail"),
    zip: validateCatalogUrl(value.zip, "zip"),
    category,
  };
  const preview = validateOptionalCatalogUrl(value.preview, "preview");
  const spritesheet = validateOptionalCatalogUrl(value.spritesheet, "spritesheet");
  const subcategory = typeof value.subcategory === "string" ? validateString(value.subcategory, "subcategory", 80) : undefined;
  return { ...pet, ...(preview ? { preview } : {}), ...(spritesheet ? { spritesheet } : {}), ...(subcategory ? { subcategory } : {}) };
}

function validateId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Catalog pet id must be a string.");
  if (value === "builtin") throw new Error("Catalog pet id 'builtin' is reserved.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`Invalid catalog pet id: ${value}`);
  return value;
}

function validateString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`Catalog pet ${field} must be a string.`);
  if (value.length > maxLength) throw new Error(`Catalog pet ${field} is too long.`);
  return value;
}

function validateCatalogUrl(value: unknown, field: "preview" | "zip" | "thumbnail" | "spritesheet"): string {
  const raw = validateString(value, field, 2048);
  const url = new URL(raw);

  if (url.protocol !== "https:") throw new Error(`${field} URL must use https.`);
  if (url.username || url.password) throw new Error(`${field} URL cannot include credentials.`);
  if (url.port) throw new Error(`${field} URL cannot include a custom port.`);

  if (field === "preview" || field === "thumbnail" || field === "spritesheet") {
    if (url.hostname !== "openpets.dev" || !url.pathname.startsWith("/pets/")) throw new Error("Preview URL host/path is not allowed.");
    if (!url.pathname.endsWith(".webp")) throw new Error(`${field} URL must be a WebP image.`);
  } else if (url.hostname !== "zip.openpets.dev" || !url.pathname.startsWith("/pets/")) {
    throw new Error("Zip URL host/path is not allowed.");
  }

  return url.toString();
}

function validateOptionalCatalogUrl(value: unknown, field: "preview" | "spritesheet"): string | undefined {
  if (value === undefined) return undefined;
  return validateCatalogUrl(value, field);
}

function validateCatalogV3Filters(value: unknown): { readonly categories: readonly CatalogV3Category[] } {
  if (!isRecord(value) || !Array.isArray(value.categories)) throw new Error("Catalog v3 filters are invalid.");
  const categories = value.categories.map(validateCatalogV3Category);
  const ids = new Set(categories.map((category) => category.id));
  if (ids.size !== categories.length || !ids.has("western") || !ids.has("asian")) throw new Error("Catalog v3 category filters are incomplete or duplicated.");
  return { categories };
}

function validateCatalogV3Category(value: unknown): CatalogV3Category {
  if (!isRecord(value)) throw new Error("Catalog v3 category must be an object.");
  const id = validateCategory(value.id);
  if (typeof value.label !== "string" || value.label.length > 40) throw new Error("Catalog v3 category label is invalid.");
  const count = value.count;
  if (!Number.isSafeInteger(count) || typeof count !== "number" || count < 0) throw new Error("Catalog v3 category count is invalid.");
  return { id, label: value.label, count };
}

function validateCatalogPageUrl(value: unknown, index: number): string {
  const raw = validateString(value, "page", 2048);
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "openpets.dev" || url.port || url.username || url.password) throw new Error("Catalog page URL origin is not allowed.");
  if (url.search || url.hash) throw new Error("Catalog page URL cannot include query or hash.");
  if (url.pathname !== `/pets/catalog.v3/page-${String(index).padStart(3, "0")}.json`) throw new Error("Catalog page URL path is not allowed.");
  return url.toString();
}

function validateCategory(value: unknown): "western" | "asian" {
  if (value === "western" || value === "asian") return value;
  throw new Error("Catalog pet category is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
