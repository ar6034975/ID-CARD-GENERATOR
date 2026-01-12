create table students (
  id uuid default gen_random_uuid() primary key,
  student_id text unique,
  name text,
  course text,
  email text,
  qr_data jsonb,
  pdf_url text,
  created_at timestamp default now()
);
