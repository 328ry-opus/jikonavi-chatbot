-- Add "ボット" as a virtual staff member for chat-originated patients
-- Run in Supabase SQL Editor (jikonavi-crm project)

INSERT INTO public.staff (user_id, staff_code, display_name, role, is_active)
VALUES (NULL, 'ボット', 'チャットbot', 'viewer', true)
ON CONFLICT (staff_code) DO NOTHING;
