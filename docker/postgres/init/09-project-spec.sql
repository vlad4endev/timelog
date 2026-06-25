-- Project technical specification: text and optional file attachment

ALTER TABLE projects ADD COLUMN IF NOT EXISTS spec_text TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS spec_file_name TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS spec_file_mime TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS spec_file_data TEXT;
