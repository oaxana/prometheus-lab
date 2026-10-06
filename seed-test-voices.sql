-- ============================================================================
-- Prometheus Lab — pretend voices for testing Synthesis
-- Paste into Supabase → SQL Editor → Run.
--
-- Inserts 12 fake submissions from 3 different "people": Me, Persona 2 and
-- Persona 3 (each has its own anonymous ID starting with demo-voter-). They are
-- flagged as TEST, so on the Synthesis tab switch on "Include test submissions".
--
-- Built-in design (what a good synthesis should find):
--   CONTESTED : pillar 1  (Me: strict opt-in | Persona 2: signage + opt-out | Persona 3: hybrid)
--               pillar 7  (Me: ban commercial AI | Persona 2: allow with conditions)
--               pillar 4  (Me: no AI cameras | Persona 2: cameras to save lives | Persona 3: cameras with human review)
--   COMMONS   : pillar 10/12 (all three: AI must admit it is AI, no deepfakes)
--               pillar 5     (Persona 2 + Persona 3: label AI-assisted art)
--   GAPS      : pillars 2, 3, 6, 8, 9, 11 are never mentioned
--
-- To remove them all afterwards, run:   delete from public.submissions where uid like 'demo-voter-%';
-- ============================================================================

insert into public.submissions (pillars, content, summary, auto_tagged, is_test, uid, display_name, created_at) values

-- =============================== ME ===============================
(array[1],
 'Any AI that records, transcribes or analyzes people on playa must be strictly opt-in. Silence is not consent. The default has to be OFF, and a person should never have to hunt for a way to say no.',
 'Argues AI recording or analysis of people must be strictly opt-in, with the default off and silence never counting as consent.',
 true, true, 'demo-voter-me', 'Me', now() - interval '60 minutes'),

(array[7],
 'No commercial AI on playa, full stop. Tools built for the playa should be gifted, and companies that want to demo or sell something should be turned away. The moment a product is sold here, we have lost the gift economy.',
 'Calls for a complete ban on commercial AI on playa, insisting playa tools be gifted.',
 true, true, 'demo-voter-me', 'Me', now() - interval '55 minutes'),

(array[4, 1],
 'Surveillance for safety is how every surveillance system begins. No AI cameras, ever. Train more humans, fund more Rangers, and keep the machines out of the watching business.',
 'Opposes any AI cameras or surveillance, arguing safety is better served by training and funding humans.',
 true, true, 'demo-voter-me', 'Me', now() - interval '50 minutes'),

(array[10, 12],
 'If an AI is talking to you, it has to say it is an AI the moment you ask, with no exceptions and no clever personas that dodge the question.',
 'Insists any AI must plainly say it is an AI whenever asked, with no persona exceptions.',
 true, true, 'demo-voter-me', 'Me', now() - interval '45 minutes'),

-- ============================ PERSONA 2 ============================
(array[1],
 'Strict opt-in everywhere is unworkable. Art and safety systems cannot ask every passerby for a signature. A visible sign plus an easy way to opt out is the realistic default.',
 'Says blanket opt-in is unworkable and proposes clear signage with easy opt-out as the default.',
 true, true, 'demo-voter-p2', 'Persona 2', now() - interval '40 minutes'),

(array[7],
 'Banning paid AI is naive, because many camps already rely on commercial tools. Allow it if it is disclosed, anything built specifically for playa is open sourced, and no playa data is ever sold or used to train a product.',
 'Argues a total ban on commercial AI is unrealistic and proposes allowing it with disclosure, open-sourcing, and no sale of playa data.',
 true, true, 'demo-voter-p2', 'Persona 2', now() - interval '35 minutes'),

(array[4, 1],
 'Rangers and medics should be able to use AI crowd monitoring, heat alerts and even cameras if it saves lives. When someone is collapsing in a dust storm, safety has to outweigh privacy. Set strict retention limits, but do not tie their hands.',
 'Supports AI crowd monitoring and cameras for Rangers and medics, prioritizing life safety with strict retention limits.',
 true, true, 'demo-voter-p2', 'Persona 2', now() - interval '30 minutes'),

(array[10],
 'Agreed that AI must never pretend to be human. If it is an AI it should say so plainly, every time someone asks.',
 'Agrees AI must never pretend to be human and must say so plainly when asked.',
 true, true, 'demo-voter-p2', 'Persona 2', now() - interval '25 minutes'),

(array[5],
 'AI-assisted art is welcome on playa, but it should be labeled so people know who made what, the human, the AI, or both. Attribution matters to the culture.',
 'Welcomes AI-assisted art but wants it labeled so attribution between human and AI is clear.',
 true, true, 'demo-voter-p2', 'Persona 2', now() - interval '20 minutes'),

-- ============================ PERSONA 3 ============================
(array[1],
 'I land in the middle. Opt-in for anything that identifies a specific person, such as faces or voices, and clear signage with opt-out for general crowd or environmental sensing.',
 'Proposes a hybrid: opt-in for anything identifying individuals, and signage with opt-out for general sensing.',
 true, true, 'demo-voter-p3', 'Persona 3', now() - interval '15 minutes'),

(array[4],
 'Cameras could be acceptable for safety, but only with a human reviewing every alert, no automatic identification of people, and footage deleted within days. The AI flags, a human decides.',
 'Accepts safety cameras only with human review of every alert, no automatic identification, and short retention.',
 true, true, 'demo-voter-p3', 'Persona 3', now() - interval '10 minutes'),

(array[12, 10, 5],
 'AI must always disclose that it is an AI, and no deepfakes of participants without consent. Same goes for art: if an installation uses AI, say so on a plaque and name who built it.',
 'Backs mandatory AI disclosure, a ban on non-consensual deepfakes, and labeling of AI-powered art installations.',
 true, true, 'demo-voter-p3', 'Persona 3', now() - interval '5 minutes');
