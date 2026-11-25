-- =====================================================================
-- Lucky Wheel: Supabase setup
-- Paste ALL of this in Supabase → SQL Editor → New query → Run.
-- >>> Change admin@demo.com below to YOUR admin email (in is_admin, below) <<<
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.wheels (
  id uuid primary key default gen_random_uuid(),
  prize_title text not null default 'New prize',
  prize_desc text not null default '',
  prize_image text not null default '',
  total_numbers int not null default 100 check (total_numbers between 1 and 100),
  price numeric not null default 5,
  currency text not null default '$',
  whish_number text not null default '',
  whish_name text not null default '',
  draw_at bigint,                 -- draw date/time (ms)
  draw jsonb,                     -- spin result (winner, startedAt…)
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  wheel_id uuid not null references public.wheels(id) on delete cascade,
  nums int[] not null,
  name text not null,
  phone text not null default '',
  status text not null default 'pending' check (status in ('pending', 'paid')),
  source text not null default 'site',
  note text not null default '',
  uid uuid,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists public.numbers (
  wheel_id uuid not null references public.wheels(id) on delete cascade,
  n int not null,
  name text not null,
  status text not null default 'pending' check (status in ('pending', 'paid')),
  req_id uuid references public.requests(id) on delete cascade,
  uid uuid,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (wheel_id, n)       -- one owner per number: first come, first served
);
create index if not exists requests_wheel_idx on public.requests(wheel_id);

-- ---------- who is admin ----------
create or replace function public.is_admin() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
     and lower(coalesce(auth.jwt() ->> 'email', '')) in ('maatouksemaan@gmail.com');
$$;

-- ---------- security (Row Level Security) ----------
alter table public.wheels   enable row level security;
alter table public.numbers  enable row level security;
alter table public.requests enable row level security;

drop policy if exists "wheels read" on public.wheels;
drop policy if exists "wheels admin" on public.wheels;
create policy "wheels read"  on public.wheels for select using (true);
create policy "wheels admin" on public.wheels for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "numbers read" on public.numbers;
drop policy if exists "numbers admin" on public.numbers;
create policy "numbers read"  on public.numbers for select using (true);   -- public: shown on the wheel (name only)
create policy "numbers admin" on public.numbers for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "requests read" on public.requests;
drop policy if exists "requests admin" on public.requests;
create policy "requests read"  on public.requests for select using (public.is_admin() or uid = auth.uid());  -- phone: admin + sender only
create policy "requests admin" on public.requests for all using (public.is_admin()) with check (public.is_admin());

-- ---------- take numbers (visitor request or admin entry), all-or-nothing ----------
create or replace function public.claim_numbers(
  p_wheel uuid, p_nums int[], p_name text, p_phone text, p_note text default '', p_as_admin boolean default false
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  w public.wheels; v_req uuid; v_taken text; v_uid uuid := auth.uid(); v_status text;
begin
  if v_uid is null then raise exception 'Please reload the page and try again.'; end if;
  if p_as_admin and not public.is_admin() then raise exception 'Not allowed.'; end if;
  select * into w from public.wheels where id = p_wheel;
  if not found then raise exception 'Wheel not found.'; end if;
  if w.draw is not null then raise exception 'The draw already happened.'; end if;
  p_name := btrim(coalesce(p_name, '')); p_phone := btrim(coalesce(p_phone, ''));
  if length(p_name) < 1 or length(p_name) > 40 then raise exception 'Write your name.'; end if;
  if length(p_phone) > 20 or (not p_as_admin and length(p_phone) < 6) then raise exception 'Write a valid phone number.'; end if;
  select array_agg(distinct x order by x) into p_nums from unnest(p_nums) x;
  if p_nums is null or cardinality(p_nums) < 1 or cardinality(p_nums) > 100 then raise exception 'Pick at least one number.'; end if;
  if exists (select 1 from unnest(p_nums) x where x < 1 or x > w.total_numbers) then raise exception 'Invalid number.'; end if;
  select string_agg(n::text, ',' order by n) into v_taken from public.numbers where wheel_id = p_wheel and n = any(p_nums);
  if v_taken is not null then raise exception 'TAKEN:%', v_taken; end if;
  v_status := case when p_as_admin then 'paid' else 'pending' end;
  begin
    insert into public.requests(wheel_id, nums, name, phone, status, source, note, uid)
      values (p_wheel, p_nums, p_name, p_phone, v_status, case when p_as_admin then 'admin' else 'site' end, left(coalesce(p_note, ''), 80), v_uid)
      returning id into v_req;
    insert into public.numbers(wheel_id, n, name, status, req_id, uid)
      select p_wheel, x, p_name, v_status, v_req, v_uid from unnest(p_nums) x;
  exception when unique_violation then
    select string_agg(n::text, ',' order by n) into v_taken from public.numbers where wheel_id = p_wheel and n = any(p_nums);
    raise exception 'TAKEN:%', coalesce(v_taken, '');
  end;
  return v_req;
end $$;

-- ---------- start the spin with the SERVER clock (same for everyone) ----------
create or replace function public.start_draw(p_wheel uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed.'; end if;
  update public.wheels
     set draw = p_data || jsonb_build_object('startedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)
   where id = p_wheel and draw is null;
  if not found then raise exception 'The draw already happened.'; end if;
end $$;

revoke all on function public.claim_numbers(uuid, int[], text, text, text, boolean) from public;
revoke all on function public.start_draw(uuid, jsonb) from public;
grant execute on function public.claim_numbers(uuid, int[], text, text, text, boolean) to anon, authenticated;
grant execute on function public.start_draw(uuid, jsonb) to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- live updates ----------
do $$ begin
  begin alter publication supabase_realtime add table public.wheels;   exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.numbers;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.requests; exception when duplicate_object then null; end;
end $$;
