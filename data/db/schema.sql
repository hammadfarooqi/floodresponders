-- Roll Call building tables for Supabase (Postgres 17 + PostGIS).
-- Safe to run again: every statement is "if not exists" or "create or replace".
-- Apply with: python3 data/db/load_supabase.py --apply-schema
-- Rules and known data problems: DATABASE.md (repo root).

create extension if not exists postgis with schema extensions;
set search_path = public, extensions;

-- One row per CoStar property, with CoStar's own values before any split across structures.
create table if not exists costar_properties (
  costar_id             text primary key,     -- CoStar PropertyId; homes are 'res-<address id>'
  kind                  text not null check (kind in ('commercial', 'residential')),
  name                  text,
  address               text,
  postcode              text,
  lat                   double precision not null,
  lng                   double precision not null,
  location              geography(point, 4326) not null,
  property_type         text,
  is_senior_housing     boolean,
  is_student_housing    boolean,
  floors                int,
  height_m              numeric,              -- only when CoStar has a measured height
  year_built            int,
  construction_material text,
  total_units           int,
  floor_area_sqft       numeric,
  is_walkup             boolean,
  passenger_elevators   int,
  has_sprinklers        boolean,
  has_basement          boolean,              -- homes only
  has_accessibility_features boolean,         -- homes only
  matterport_model_ids  text[] not null default '{}'
);

-- One row per Vexcel structure, plus one row per CoStar property that has no Vexcel structure.
create table if not exists buildings (
  id                    uuid primary key,     -- made from the parcel and footprint, so a reload keeps the same id
  parcel_key            text,                 -- same value for all structures on one Vexcel parcel
  costar_id             text references costar_properties,
  lat                   double precision not null,
  lng                   double precision not null,
  location              geography(point, 4326) not null,

  -- Vexcel, as measured. All null when the row is CoStar-only.
  footprint             geography(multipolygon, 4326),
  footprint_area_m2     numeric,
  ground_elevation_m    numeric,
  vexcel_height_m       numeric,
  vexcel_building_type  text,
  is_primary_on_parcel  boolean,
  roof_condition        int,                  -- 1 to 5; direction not documented (see DATABASE.md)
  roof_material         text,
  roof_shape            text,
  tree_density_zone1    numeric,              -- rings around the structure, nearest first
  tree_density_zone2    numeric,
  tree_density_zone3    numeric,
  tree_density_zone4    numeric,
  building_density_zone1 numeric,
  building_density_zone2 numeric,
  building_density_zone3 numeric,
  building_density_zone4 numeric,
  parcel_tree_cover_pct numeric,
  parcel_hardscape_pct  numeric,
  vexcel_survey         text,
  vexcel_survey_date    date,

  -- Resolved values: what the app uses. *_source is 'costar', 'vexcel', 'assessor', 'estimated' or null.
  building_type         text,
  building_type_source  text,
  height_m              numeric,
  height_source         text,
  floors                int,
  floors_source         text,
  units                 int,
  units_source          text,
  est_occupants         int,
  occupants_source      text,
  construction_material text,                 -- CoStar only
  year_built            int,                  -- CoStar only
  is_walkup             boolean,              -- CoStar only
  passenger_elevators   int,                  -- CoStar only
  has_sprinklers        boolean,              -- CoStar only

  -- Quality
  is_accessory          boolean not null default false,   -- shed, garage, carport
  height_suspect        boolean not null default false,   -- Vexcel height under 3 m and not accessory
  shares_costar_property boolean not null default false,  -- CoStar values were given to 2+ structures
  confidence            numeric                           -- 0 to 1
);
create index if not exists buildings_location_idx on buildings using gist (location);
create index if not exists buildings_footprint_idx on buildings using gist (footprint);
create index if not exists buildings_costar_id_idx on buildings (costar_id);
create index if not exists buildings_parcel_key_idx on buildings (parcel_key);

create table if not exists contacts (
  id              uuid primary key,
  costar_id       text not null references costar_properties,
  role            text not null,              -- 'site_office' | 'property_manager'
  company_name    text,
  phone           text,
  is_test_number  boolean not null default false   -- true for our own demo phones
);
create index if not exists contacts_costar_id_idx on contacts (costar_id);

-- Row security is on and there are no rules. Only the secret key (server code) can read or write.
alter table costar_properties enable row level security;
alter table buildings enable row level security;
alter table contacts enable row level security;

-- The REST API returns geography columns as hex text. This view gives the footprint as GeoJSON.
create or replace view buildings_geojson with (security_invoker = true) as
select b.*, st_asgeojson(b.footprint)::jsonb as footprint_geojson
from buildings b;

-- Buildings within radius_m meters of a point, nearest first.
-- REST: POST /rest/v1/rpc/buildings_near  {"p_lat": 34.1, "p_lng": -118.33, "radius_m": 500}
create or replace function buildings_near(p_lat double precision, p_lng double precision, radius_m double precision)
returns setof buildings
language sql stable
set search_path = public, extensions
as $$
  select b.*
  from buildings b
  where st_dwithin(b.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography, radius_m)
  order by st_distance(b.location, st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography)
$$;

notify pgrst, 'reload schema';
