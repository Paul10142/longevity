/**
 * One-shot taxonomy reshape toward the 7 patient-facing pillars.
 *
 *   npx tsx --env-file=.env.local scripts/curate.ts --dry-run   # validate + preview, write nothing
 *   npx tsx --env-file=.env.local scripts/curate.ts             # apply, append change-log
 *
 * Plan authored 2026-07-27 from the live tree (203 active topics). Paul approved
 * a full autonomous reshape (reversible: every merge archives with merged_into_id).
 * Reference shape = peterattiamd.com/topics. Uses the sanctioned human-curation
 * primitives in lib/topicOps.ts so the M:N claim_topics batching + concurrent-tag
 * race fix (ebe3697) are reused, not re-implemented.
 *
 * Ops apply in array order (dependencies matter — a rename that names a merge
 * target comes before the merges into it; children reparent out of a folded root
 * before the root itself is merged away). Each op is validated against the live
 * tree first; an unknown/inactive id is SKIPPED with a warning rather than
 * aborting the batch, and a per-op failure is logged and the run continues.
 */
import { renameTopic, reparentTopic, mergeTopics, archiveTopic } from "../lib/topicOps"
import { supabaseAdmin } from "../lib/supabaseServer"
import { writeFileSync, appendFileSync } from "node:fs"

type Op =
  | { op: "rename"; id: string; to: string; note?: string }
  | { op: "reparent"; id: string; parent: string | null; note?: string }
  | { op: "merge"; from: string; into: string; note?: string }
  | { op: "archive"; id: string; note?: string }

// ── IDs from the live tree (2026-07-27) ──────────────────────────────
// Roots
const EXERCISE = "84f9a765-481c-4daa-a78a-145a85c9197c"
const HEALTHY_AGING = "48cb0bf1-7b31-4ed8-92d8-e780bda9294b"
const MENTAL = "e2b05258-8f08-4614-bd25-fbad7f6b12ee"
const NUTRITION = "cffdd481-b6ef-4436-9fb6-bc1cecb63381"
const REDUCING_RISKS = "ba7d66a7-88fb-4b2b-9266-bf3012de3bd5"

const PLAN: Op[] = [
  // ══ EXERCISE ══════════════════════════════════════════════════════
  // Cardiorespiratory Fitness = VO2 Max + Zone 2 + High-Intensity/Zone 5 (Paul)
  { op: "rename", id: "fa658bb2-eafd-41f7-903a-06b9b2583166", to: "Cardiorespiratory Fitness", note: "VO2 Max → Cardiorespiratory Fitness" },
  { op: "merge", from: "fffe5ece-da01-4c89-9d68-6f82236e721d", into: "fa658bb2-eafd-41f7-903a-06b9b2583166", note: "Zone 2 → Cardiorespiratory Fitness" },
  { op: "merge", from: "67344c74-355d-450b-9744-3b68528fdfbd", into: "fa658bb2-eafd-41f7-903a-06b9b2583166", note: "High Intensity & Zone 5 → Cardiorespiratory Fitness" },
  // Resistance Training absorbs Strength & Muscle Mass (Paul confirmed) + Power Training + its own empty subtopics
  { op: "merge", from: "0d1afd8a-493c-49fb-ae69-3bc6ba23da4a", into: "5bfc6d45-4982-4b5f-9398-30e1ae83124f", note: "Strength & Muscle Mass → Resistance Training" },
  { op: "merge", from: "7d85b0a6-92b0-4248-9f7e-70fd52ad739f", into: "5bfc6d45-4982-4b5f-9398-30e1ae83124f", note: "Power Training → Resistance Training" },
  { op: "merge", from: "e16c0adc-df16-4c1e-9135-6100ebaccd5a", into: "5bfc6d45-4982-4b5f-9398-30e1ae83124f", note: "flatten empty L3 → Resistance Training" },
  { op: "merge", from: "b0e296c5-3384-4dd2-b9c6-bbf154256917", into: "5bfc6d45-4982-4b5f-9398-30e1ae83124f", note: "flatten empty L3 → Resistance Training" },
  { op: "merge", from: "e18409cd-ecb3-40ec-bf6d-eceacf89cdd0", into: "5bfc6d45-4982-4b5f-9398-30e1ae83124f", note: "flatten empty L3 → Resistance Training" },
  // Drop Exercise & Male Fertility (Paul; 0 claims)
  { op: "archive", id: "01795e3c-51ef-432b-9e0f-73130eecad64", note: "drop Exercise And Male Fertility (empty)" },

  // ══ HEALTHY AGING → fold into the pillars (Paul) ══════════════════
  // Consolidate the longevity-concept children into one, homed under Reducing Risks
  { op: "merge", from: "725f0d4b-35b2-4335-94e1-f026ae9a8723", into: "eb93f0a0-eb77-4c25-b0d7-4a1cf76ca57a", note: "Lifespan → Healthspan Measurement" },
  { op: "merge", from: "6dbc1125-7e17-462e-b5ac-55a5b040258e", into: "eb93f0a0-eb77-4c25-b0d7-4a1cf76ca57a", note: "Longevity Definitions → Healthspan Measurement" },
  { op: "merge", from: "ef09172d-fd86-4809-b8de-cc409e10a750", into: "eb93f0a0-eb77-4c25-b0d7-4a1cf76ca57a", note: "Mortality Risk Prediction → Healthspan Measurement" },
  { op: "merge", from: "3d001fa4-428f-4665-8631-ecaf30b041b5", into: "eb93f0a0-eb77-4c25-b0d7-4a1cf76ca57a", note: "Oxidative Stress → Healthspan Measurement (bullet)" },
  { op: "rename", id: "eb93f0a0-eb77-4c25-b0d7-4a1cf76ca57a", to: "Healthspan & Lifespan", note: "consolidated longevity-concept topic" },
  { op: "reparent", id: "eb93f0a0-eb77-4c25-b0d7-4a1cf76ca57a", parent: REDUCING_RISKS, note: "Healthspan & Lifespan → Reducing Risks" },
  // Distribute the two lever-children
  { op: "reparent", id: "e23febc9-b641-4041-a0af-86a8d18fbbf1", parent: MENTAL, note: "Cognitive Aging → Mental Health & Cognition" },
  { op: "reparent", id: "628c4b97-ca6a-466f-ac66-ef8b2ca1ec1b", parent: EXERCISE, note: "Functional Aging → Exercise" },
  // Root now childless → merge (its 4 own claims → Reducing Risks), archives root
  { op: "merge", from: HEALTHY_AGING, into: REDUCING_RISKS, note: "fold Healthy Aging root → Reducing Risks" },

  // ══ NUTRITION ═════════════════════════════════════════════════════
  // Dietary Fat = collapse the fat + seed-oil split (Paul)
  { op: "rename", id: "b8bc3581-833f-4dcb-bd9a-f1648c92561f", to: "Dietary Fat", note: "Polyunsaturated Fat → Dietary Fat (home)" },
  { op: "merge", from: "1a6f20a1-b3cb-4b51-bb30-aa0c7d073261", into: "b8bc3581-833f-4dcb-bd9a-f1648c92561f", note: "Monounsaturated Fat → Dietary Fat" },
  { op: "merge", from: "5a8e98db-7b05-45c4-846a-8dc7a2d330a6", into: "b8bc3581-833f-4dcb-bd9a-f1648c92561f", note: "Seed Oils → Dietary Fat" },
  { op: "merge", from: "0658451d-aec4-49f8-8eef-04f9b3cd896d", into: "b8bc3581-833f-4dcb-bd9a-f1648c92561f", note: "Seed Oils & Dietary Fat Debates → Dietary Fat" },
  { op: "merge", from: "506cfffd-74a9-4ce3-af29-07ef87ab2ff2", into: "b8bc3581-833f-4dcb-bd9a-f1648c92561f", note: "Seed Oil Extraction & Refining → Dietary Fat" },
  { op: "merge", from: "8c852f04-8a2b-44c8-b350-e86a1c550bc8", into: "b8bc3581-833f-4dcb-bd9a-f1648c92561f", note: "Seed Oils & Industrial Oil Processing → Dietary Fat" },
  // Protein = merge Protein Intake into the spine Protein topic (Paul)
  { op: "merge", from: "e65f70d0-505d-4c85-9849-15229f8405e5", into: "366fb6c0-bc1d-47bb-9063-ff213e9698e2", note: "Protein Intake → Protein" },
  { op: "merge", from: "b5163399-c546-490f-80bb-b02b618bf99a", into: "366fb6c0-bc1d-47bb-9063-ff213e9698e2", note: "Protein Intake Safety & Upper Limits → Protein" },
  { op: "merge", from: "a593e180-4157-4602-b3ac-d22b11707b37", into: "366fb6c0-bc1d-47bb-9063-ff213e9698e2", note: "Protein Timing & Distribution → Protein" },
  // Food Systems: fold empty/near-empty children in
  { op: "merge", from: "1a34494e-bc08-4090-9617-7eb0d91aa92d", into: "c744e600-f3f1-4ced-bcbf-dcb023135d56", note: "Fair Trade Sourcing → Food Systems" },
  { op: "merge", from: "1038006a-93a6-46e5-9f2a-ca334c90d2ff", into: "c744e600-f3f1-4ced-bcbf-dcb023135d56", note: "Food Labeling → Food Systems" },
  { op: "merge", from: "83a62419-309f-4975-a996-f74f82b5c218", into: "c744e600-f3f1-4ced-bcbf-dcb023135d56", note: "Food Processing → Food Systems" },
  { op: "merge", from: "a169907f-9e58-41d5-816e-ffd4fbea22b3", into: "c744e600-f3f1-4ced-bcbf-dcb023135d56", note: "Natural Toxins → Food Systems" },
  { op: "merge", from: "7a1c9e67-2713-4e36-8628-fe574df62fc3", into: "c744e600-f3f1-4ced-bcbf-dcb023135d56", note: "Ultra-Processed Food Classification → Food Systems" },
  // Dietary Optimization: fold empty child
  { op: "merge", from: "659a1c3f-df80-4dcf-894c-c56aa51c1663", into: "753a9de3-f430-4a8a-b548-b910999b9583", note: "Dietary Heuristics & Food Rules → Dietary Optimization" },

  // ══ REDUCING RISKS ════════════════════════════════════════════════
  // Cancer absorbs Oncology (Paul) + its empty children
  { op: "merge", from: "d9e2c5a9-b371-4b71-8691-97e67a3f6fbf", into: "18641a59-1fbf-4a8d-9611-53bafbc4616d", note: "Oncology → Cancer" },
  { op: "merge", from: "340d0e0a-51cb-48de-9b05-6b43aad59ad2", into: "18641a59-1fbf-4a8d-9611-53bafbc4616d", note: "Cancer Genetics → Cancer" },
  { op: "merge", from: "6bb2220a-e2b2-4afe-901d-604e484411f0", into: "18641a59-1fbf-4a8d-9611-53bafbc4616d", note: "Cancer Risk Factors → Cancer" },
  // Cardiovascular Disease: fold empty mechanism children; keep Lipidology, flatten its L4
  { op: "merge", from: "4b47e46f-381b-4e4a-9052-976bd2f8f49f", into: "3bd1ad50-3429-4d5b-8d46-23ab8dfb9fdd", note: "Acute Coronary Syndromes → CVD" },
  { op: "merge", from: "07e8e97d-9bed-496a-92dc-42f594b4cd34", into: "3bd1ad50-3429-4d5b-8d46-23ab8dfb9fdd", note: "Atherosclerotic CVD → CVD" },
  { op: "merge", from: "784d60a6-dd8e-4392-9835-59c38ebd8128", into: "3bd1ad50-3429-4d5b-8d46-23ab8dfb9fdd", note: "CVD Prevention → CVD" },
  { op: "merge", from: "32872ee5-8b4d-4816-b2ec-37caf3fd4267", into: "3bd1ad50-3429-4d5b-8d46-23ab8dfb9fdd", note: "Dietary Fat & CV Outcomes → CVD" },
  { op: "merge", from: "c850f2e2-f511-4808-9808-21c6f2031d6b", into: "3bd1ad50-3429-4d5b-8d46-23ab8dfb9fdd", note: "Vascular Inflammation → CVD" },
  { op: "merge", from: "a8a69524-08fa-4068-9279-57fccd539f0b", into: "c1eea135-f7f5-444f-89c3-13c6a1138d4d", note: "Apolipoprotein B → Lipidology (flatten L4)" },
  // Metabolic Health: fold empty mechanism children
  { op: "merge", from: "eb2a8fc6-597a-4924-ac5a-2f8fe91eb318", into: "fe62c38c-6378-4706-b1a9-f1bcf42a7d80", note: "AMPK Signaling → Metabolic Health" },
  { op: "merge", from: "5513031c-fd0a-41e0-9d3a-f368fffa1cd4", into: "fe62c38c-6378-4706-b1a9-f1bcf42a7d80", note: "Hyperinsulinemia → Metabolic Health" },
  { op: "merge", from: "893997c8-dc84-401a-b13d-55ba84f9abce", into: "fe62c38c-6378-4706-b1a9-f1bcf42a7d80", note: "mTOR Signaling → Metabolic Health" },
  { op: "merge", from: "64cddaa7-7f19-4f2d-8196-8469419e30ad", into: "fe62c38c-6378-4706-b1a9-f1bcf42a7d80", note: "Obesity & Energy Balance → Metabolic Health" },
  { op: "merge", from: "aa420b1e-33fb-4fac-8b69-6de3472cd045", into: "fe62c38c-6378-4706-b1a9-f1bcf42a7d80", note: "Obesity Prevention & Social Determinants → Metabolic Health" },
  // Thyroid Disorders: flatten its 6 empty L4 children
  { op: "merge", from: "502fc513-f9db-405c-a634-a01898e7689b", into: "837d0945-809d-4f48-924b-2bdce90325ff", note: "Hypothyroidism Dx & Tx → Thyroid Disorders" },
  { op: "merge", from: "2999208b-ecf4-40c8-9af4-6c775e460556", into: "837d0945-809d-4f48-924b-2bdce90325ff", note: "Thyroid Diagnosis, Testing & Treatment → Thyroid Disorders" },
  { op: "merge", from: "435bbcf7-7d52-4de0-9249-d0735d0e68f1", into: "837d0945-809d-4f48-924b-2bdce90325ff", note: "Thyroid Diagnostics & Monitoring → Thyroid Disorders" },
  { op: "merge", from: "3c4b388a-2bea-49a3-8095-4a6eabcb7788", into: "837d0945-809d-4f48-924b-2bdce90325ff", note: "Thyroid Function Testing → Thyroid Disorders" },
  { op: "merge", from: "bf7083bb-1fdf-4d97-a870-98d6f08f9001", into: "837d0945-809d-4f48-924b-2bdce90325ff", note: "Thyroid Hormone Physiology → Thyroid Disorders" },
  { op: "merge", from: "573e7ed2-0b0a-4da3-8fc9-d104031349f0", into: "837d0945-809d-4f48-924b-2bdce90325ff", note: "Thyroid Hormone Replacement Therapy → Thyroid Disorders" },
  // Pulmonology: fold empty child
  { op: "merge", from: "7126388d-ef50-432b-bcaa-5bc637849c46", into: "ae4957ac-0eb9-4c72-9343-720853991026", note: "COPD → Pulmonology" },

  // ══ MENTAL HEALTH & COGNITION ═════════════════════════════════════
  { op: "merge", from: "93f5ed71-9ab1-4e75-a461-92868e837563", into: "f88365d4-5427-4e01-861a-d567733ffd42", note: "Behavior Change → Behavioral Science" },
  { op: "merge", from: "65957e88-fad5-4088-8704-0563bcbbbf4c", into: "f88365d4-5427-4e01-861a-d567733ffd42", note: "Eating Behavior & Food Choice → Behavioral Science" },
  { op: "merge", from: "2f75eada-b572-4e70-aaf5-33bfa54403c6", into: "f88365d4-5427-4e01-861a-d567733ffd42", note: "Evolutionary Psychology → Behavioral Science" },
  { op: "merge", from: "5d987502-314e-44a0-b871-de4f780a3fea", into: "f88365d4-5427-4e01-861a-d567733ffd42", note: "Practice & Skill Acquisition → Behavioral Science" },
  { op: "merge", from: "fe3b646d-9966-49bb-8e84-0640751a272f", into: "f88365d4-5427-4e01-861a-d567733ffd42", note: "Sex Differences in Aggression → Behavioral Science" },
  // Media & Technology absorbs its two leaf children (Paul: bullets, not sub-topics)
  { op: "merge", from: "01ad0069-1348-4523-8bf0-d68c3ff76300", into: "63113704-081e-4797-b676-83db19c0ce77", note: "Digital Media Impact → Media & Technology" },
  { op: "merge", from: "daa3c22b-d75c-40ef-a707-f0afd9b132f6", into: "63113704-081e-4797-b676-83db19c0ce77", note: "Video Game Effects → Media & Technology" },
  { op: "merge", from: "80b52ae5-41f4-4e37-a141-3f2d43eac34c", into: "1339c16b-03db-4546-b198-b6ee4a8a5a69", note: "Neurodevelopmental Disorders → Neurodevelopment" },
  { op: "merge", from: "89c7db0f-73c5-49af-8f16-1b32707f0ddd", into: "1339c16b-03db-4546-b198-b6ee4a8a5a69", note: "Neurodiversity → Neurodevelopment" },
  { op: "merge", from: "df35bb86-5cad-454f-b5d5-1354b8543101", into: "4130cf7f-f457-4f8d-abf9-a87fcefdfb5a", note: "Crossmodal Neuroplasticity → Neuroscience" },
  { op: "merge", from: "0d6b6b47-c76b-4a8e-b0dd-583f737ba7c7", into: "04cc9915-6c88-441a-ad00-5e52cfa619d5", note: "Work Identity → Quality of Life" },

  // ══ REPRODUCTIVE & HORMONAL HEALTH — collapse the sprawl ══════════
  // Endocrinology absorbs the empty hormone-mechanism children
  { op: "merge", from: "dcba79ae-75b2-48b8-8f3e-28cd720d26d9", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "5α-Reductase Deficiency → Endocrinology" },
  { op: "merge", from: "e79b6bee-97dc-4605-99b2-bb8e7e363ca2", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "Aromatase Deficiency → Endocrinology" },
  { op: "merge", from: "4a1dd0cb-6254-499a-b83a-747a9dd94aaa", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "DHT → Endocrinology" },
  { op: "merge", from: "dfd75c50-1996-434a-afe4-0ba5acf7eba6", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "Estrogen in Men → Endocrinology" },
  { op: "merge", from: "68eb5926-c86f-4554-863f-c095d822dac0", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "Estrogen Physiology → Endocrinology" },
  { op: "merge", from: "6da28c7b-83ba-4e05-ab13-6d94541047d5", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "Gonadotropin Signaling → Endocrinology" },
  { op: "merge", from: "6ed9083e-1060-4b1c-8dd0-1c4215f2a72c", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "Organizational vs Activational Effects → Endocrinology" },
  { op: "merge", from: "e4b28dd6-7180-49eb-abac-300813f73f95", into: "4415fc8e-8072-480e-8f45-18bc1c6c8a2e", note: "Testosterone → Endocrinology" },
  // Diagnostics absorbs empty child
  { op: "merge", from: "a661cefa-e8f9-42e7-bbfc-2150141e460b", into: "6edc779a-f4de-4bda-ba57-32133d2fb61e", note: "Androgen Receptor Testing → Diagnostics" },
  // Male Reproductive Health = clinical male-fertility bucket
  { op: "merge", from: "bfe5e54f-a609-44b3-9512-aebd919f415d", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Alcohol and Male Fertility → Male Reproductive Health" },
  { op: "merge", from: "3ace0268-004e-4e70-838e-8b285d13ed47", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Assisted Reproduction → Male Reproductive Health" },
  { op: "merge", from: "952ac2e4-038a-421e-97d6-b3e8eca58252", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Assisted Reproduction Techniques → Male Reproductive Health" },
  { op: "merge", from: "f320ea7c-8099-42b1-b09d-acd1944834c4", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Sperm Selection Technologies → Male Reproductive Health" },
  { op: "merge", from: "6b120cc0-2d56-47ab-8b68-cb3f85f75616", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Fertility → Male Reproductive Health" },
  { op: "merge", from: "7fc25a8e-a259-423b-8a9a-ffa33262ba3d", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Male Infertility Treatment → Male Reproductive Health" },
  { op: "merge", from: "80b0b624-d8fc-4efc-99da-6ccc8c17c292", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Fertility Preservation → Male Reproductive Health" },
  { op: "merge", from: "5957e9d5-1a80-48a7-bf0b-4bb9578ce50c", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Male Fertility Assessment → Male Reproductive Health" },
  { op: "merge", from: "6a6cf424-6ad0-46c3-906d-2448236d456d", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Male Reproductive Anatomy → Male Reproductive Health" },
  { op: "merge", from: "f32ce657-5be7-4aec-9b27-c5e0740ea410", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Reproductive Aging → Male Reproductive Health" },
  { op: "merge", from: "6cd384fd-2781-4cac-9114-36fb5089d99a", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Paternal Age → Male Reproductive Health" },
  // Sperm & Reproductive Biology = all gamete/sperm cell biology
  { op: "rename", id: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", to: "Sperm & Reproductive Biology", note: "Reproductive Biology → Sperm & Reproductive Biology (home)" },
  { op: "merge", from: "36763710-bdf6-4fa8-9c37-b1a9c1eef790", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Fertilization Mechanisms → Sperm & Reproductive Biology" },
  { op: "merge", from: "7e5d7ff8-6c8e-437a-897a-14b95e16e99c", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Meiosis & Genetic Recombination → Sperm & Reproductive Biology" },
  { op: "merge", from: "0ba44086-21ad-4336-9fba-96795372e343", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm–Female Tract Interaction → Sperm & Reproductive Biology" },
  { op: "merge", from: "05a77f36-661a-4744-8e82-bf285469bb05", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Spermatogenesis → Sperm & Reproductive Biology" },
  { op: "merge", from: "fb402791-fac8-41ae-a1d0-7c1977038cd0", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm Bioenergetics → Sperm & Reproductive Biology" },
  { op: "merge", from: "c9498f70-7853-40df-9cad-27f26a8fa1f1", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm Chemotaxis → Sperm & Reproductive Biology" },
  { op: "merge", from: "d82a825c-b4b7-4f77-917d-8597d254ce7a", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm DNA Integrity → Sperm & Reproductive Biology" },
  { op: "merge", from: "1b79b00a-88a4-4a8f-a5f7-99d6b7e24732", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm Epigenetics → Sperm & Reproductive Biology" },
  { op: "merge", from: "32091207-5323-4918-b28c-33eca3987f62", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm Motility → Sperm & Reproductive Biology" },
  { op: "merge", from: "635148d3-632e-48fc-ad71-c2b9b4d6a1da", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Sperm Storage → Sperm & Reproductive Biology" },
  { op: "merge", from: "61b486e9-848b-46f7-a8b8-efa501e9db27", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Blood-Testis Barrier → Sperm & Reproductive Biology" },
  { op: "merge", from: "ac57832e-0615-4337-b3da-a3213986cc29", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Epididymal Maturation → Sperm & Reproductive Biology" },
  { op: "merge", from: "bcef38ff-220a-4ecc-adc4-692de3c175fd", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Testicular Thermoregulation → Sperm & Reproductive Biology" },
  { op: "merge", from: "0e72005d-0271-4856-806a-5a8165773041", into: "4240e7ee-37c0-4a9a-9b42-35c658bc36f7", note: "Bicycle Saddle Ergonomics → Sperm & Reproductive Biology" },
  { op: "merge", from: "079dfff8-2019-4157-9771-35f32501f5ab", into: "8777cdff-107b-4c1a-ac63-d9ec64d8a32f", note: "Varicocele Repair → Male Reproductive Health" },
  // Genetics (reproductive) absorbs its empty children
  { op: "merge", from: "06604a21-f345-47c5-bfa5-1311f5d99cdf", into: "28780bcc-65c2-4afd-a541-d7e11333278c", note: "CFTR Genetics → Genetics" },
  { op: "merge", from: "d049f7c6-3fdb-4c0c-87a0-25e0737c2489", into: "28780bcc-65c2-4afd-a541-d7e11333278c", note: "Genetic Infertility → Genetics" },
  { op: "merge", from: "072304e8-7de2-4787-92b0-6fa00f4113a9", into: "28780bcc-65c2-4afd-a541-d7e11333278c", note: "Germline Aneuploidy → Genetics" },
  { op: "merge", from: "d4a51f4d-5984-419b-9e15-59d19fe3be83", into: "28780bcc-65c2-4afd-a541-d7e11333278c", note: "Sex Chromosome Aneuploidy → Genetics" },
  // Evolutionary & Developmental Biology absorbs its whole academic subtree
  { op: "merge", from: "498cf90c-e28a-4a8b-9653-5e85e519e772", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Anthropology → Evo & Dev Biology" },
  { op: "merge", from: "d6e4f427-d60b-41ab-bdcf-6ec7f31cfd41", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Cross-Cultural Research → Evo & Dev Biology" },
  { op: "merge", from: "b00a76e3-6be6-4671-81dc-9690a73a3715", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Child Development → Evo & Dev Biology" },
  { op: "merge", from: "c9c8bf6a-d724-478d-9069-398ecdf38a26", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Rough-and-Tumble Play → Evo & Dev Biology" },
  { op: "merge", from: "e16ddb0b-a9be-4abf-baed-4968bc5e9cd5", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Sibling Dynamics → Evo & Dev Biology" },
  { op: "merge", from: "0eb5a0b3-4dda-4f28-8cd1-a44dbfc55acb", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Comparative Biology → Evo & Dev Biology" },
  { op: "merge", from: "eb2688a5-e65c-42f1-91d9-73e30e155d11", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Comparative Primate Behavior → Evo & Dev Biology" },
  { op: "merge", from: "69f5b350-2d6a-462e-8114-cc8af55807f5", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Developmental Biology → Evo & Dev Biology" },
  { op: "merge", from: "79bf775c-ee8d-421f-b514-bf309700f07d", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Prenatal Androgen Exposure → Evo & Dev Biology" },
  { op: "merge", from: "7f536ef1-c94b-4498-9479-37040766c21a", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Sexual Differentiation → Evo & Dev Biology" },
  { op: "merge", from: "a992c47a-b2b7-42be-865d-bce2251727a9", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Proximate vs Ultimate Explanations → Evo & Dev Biology" },
  { op: "merge", from: "33bd9923-7e44-4dcc-8ef1-ecac8032383b", into: "3655f4ed-af8d-45f7-af9a-9b9bc7ec8a83", note: "Reproductive Strategies → Evo & Dev Biology" },
  // Regenerative Medicine absorbs its child
  { op: "merge", from: "0489b1ef-79e8-46f2-9dd9-a8c73f88aef1", into: "d72cad57-ac20-48c1-bd06-ce3bcd39a211", note: "Reproductive Regenerative Therapies → Regenerative Medicine" },

  // ══ PUBLIC HEALTH & POLICY (light: fold empties) ══════════════════
  { op: "merge", from: "2802f48e-86d0-474b-afb3-b026482cef65", into: "c0abc7a7-602a-4b6e-b88e-7dd0aaa1ecbb", note: "Medical Disclaimer → Health Communication" },
  { op: "merge", from: "bf21f6f0-b77c-46eb-ab7e-03866e66b4d7", into: "ea56f0c8-c501-447e-a600-f31f146b7494", note: "Health System Financing → Health Systems" },
  { op: "merge", from: "25812986-5234-4529-a428-a1b8b7bae8c4", into: "ea56f0c8-c501-447e-a600-f31f146b7494", note: "Preventive Medicine → Health Systems" },
  { op: "merge", from: "202957ae-e0ad-4330-986f-e38783307eee", into: "fbf3d288-7f74-4c08-a60c-684fec0288fd", note: "Institutional Betrayal → Organizational Behavior" },
  { op: "merge", from: "1b66bf8e-1169-460c-a843-860bf0cc8eaa", into: "b35d6057-dafb-420d-a4c0-a4490cda24a0", note: "Drug Development Economics → Pharmaceuticals" },
  { op: "merge", from: "06a90b00-53d1-47de-9240-04c41627bd5a", into: "33e1cdc0-9f1f-4ce5-83cf-907b0b64c253", note: "Substance-Impaired Driving → Public Health" },
  { op: "merge", from: "d95028e4-8ba9-4312-bd4a-301053168c25", into: "aee38dac-8988-48bf-90d5-82c3f4704d2c", note: "THC Pharmacokinetics → Substance Use" },

  // ══ RESEARCH & EVIDENCE (light: fold empties + dup children) ══════
  { op: "merge", from: "208ba0ca-180f-471e-a0de-d653fc538767", into: "5ed5d878-8161-4ade-bf87-dc8a4cfe42a7", note: "AI in Peer Review → Peer Review" },
  { op: "merge", from: "d6c0804a-0be1-471e-9e2b-86421fb80097", into: "5ed5d878-8161-4ade-bf87-dc8a4cfe42a7", note: "Automated Statistical Checks → Peer Review" },
  { op: "merge", from: "590f0792-ed55-4c65-974e-25edf472cd63", into: "41e8774b-3306-4766-82ed-4e8c8dbba3db", note: "Causal Inference & Evidence Appraisal → Scientific Method" },
  { op: "merge", from: "0bb76a1f-164e-4c63-a3b7-bf7335acff99", into: "056ecf5d-98a3-4ed7-aa49-82ad1b94d7d5", note: "Research Ethics → Ethics" },
  { op: "merge", from: "ac84ffa9-d6e2-4a8e-aab8-225c2a624def", into: "d250e2c1-7bae-485f-aefa-edb05d887413", note: "Statistical Power & Interpretation → RCT" },
  { op: "merge", from: "fb58d396-d30d-43f6-b826-100937fc2320", into: "d250e2c1-7bae-485f-aefa-edb05d887413", note: "Statistical Power & Sample Size → RCT" },
  { op: "merge", from: "3d176a1e-5b18-4833-861f-0df5e5581c48", into: "d250e2c1-7bae-485f-aefa-edb05d887413", note: "Trial Design & Endpoint Selection → RCT" },
  { op: "merge", from: "09fecbe7-5eb7-4903-a67e-536a656efbf8", into: "d250e2c1-7bae-485f-aefa-edb05d887413", note: "Trial Design & Endpoints → RCT" },
]

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const db = supabaseAdmin
  if (!db) throw new Error("Supabase not configured")

  // Load the live active tree.
  const { data: topicRows, error } = await db
    .from("topics")
    .select("id, name, parent_id, status")
    .eq("status", "active")
  if (error) throw new Error(error.message)
  const topics = new Map<string, { name: string; parent_id: string | null }>()
  for (const t of (topicRows ?? []) as { id: string; name: string; parent_id: string | null }[]) {
    topics.set(t.id, { name: t.name, parent_id: t.parent_id })
  }

  const logPath = `scratchpad/curate-changelog-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`
  const name = (id: string) => topics.get(id)?.name ?? "??(missing/inactive)"

  console.log(`\n${dryRun ? "DRY RUN — validating, nothing written" : "APPLYING reshape"} · ${PLAN.length} ops\n`)
  let ok = 0, skipped = 0, failed = 0
  const records: unknown[] = []

  for (let i = 0; i < PLAN.length; i++) {
    const op = PLAN[i]
    const tag = `[${String(i + 1).padStart(3)}/${PLAN.length}]`

    // Validate referenced ids exist & are active in our snapshot.
    const ids = op.op === "merge" ? [op.from, op.into] : op.op === "reparent" ? [op.id, ...(op.parent ? [op.parent] : [])] : [op.id]
    const missing = ids.filter((id) => !topics.has(id))
    if (missing.length) {
      console.log(`${tag} SKIP ${op.op} — missing/inactive: ${missing.join(", ")}  (${op.note ?? ""})`)
      skipped++
      continue
    }

    const desc =
      op.op === "merge" ? `merge "${name(op.from)}" → "${name(op.into)}"`
      : op.op === "reparent" ? `reparent "${name(op.id)}" under ${op.parent ? `"${name(op.parent)}"` : "(root)"}`
      : op.op === "rename" ? `rename "${name(op.id)}" → "${op.to}"`
      : `archive "${name(op.id)}"`

    if (dryRun) {
      console.log(`${tag} ${desc}`)
      // Mutate the in-memory snapshot so later ops validate against the projected tree.
      if (op.op === "merge") topics.delete(op.from)
      else if (op.op === "archive") topics.delete(op.id)
      else if (op.op === "rename") topics.get(op.id)!.name = op.to
      else if (op.op === "reparent") topics.get(op.id)!.parent_id = op.parent
      ok++
      continue
    }

    try {
      if (op.op === "merge") await mergeTopics(db, op.from, op.into)
      else if (op.op === "reparent") await reparentTopic(db, op.id, op.parent)
      else if (op.op === "rename") await renameTopic(db, op.id, op.to)
      else if (op.op === "archive") await archiveTopic(db, op.id)
      console.log(`${tag} ✓ ${desc}`)
      records.push({ i: i + 1, ...op, desc, at: new Date().toISOString() })
      // keep snapshot current
      if (op.op === "merge") topics.delete(op.from)
      else if (op.op === "archive") topics.delete(op.id)
      else if (op.op === "rename") topics.get(op.id)!.name = op.to
      else if (op.op === "reparent") topics.get(op.id)!.parent_id = op.parent
      ok++
    } catch (e) {
      console.log(`${tag} ✗ FAILED ${desc}: ${e instanceof Error ? e.message : e}`)
      records.push({ i: i + 1, ...op, error: String(e instanceof Error ? e.message : e) })
      failed++
    }
  }

  if (!dryRun) {
    writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    console.log(`\nChange-log → ${logPath}`)
  }
  console.log(`\nDone. ${ok} ok · ${skipped} skipped · ${failed} failed.\n`)
}

main().catch((e) => { console.error(e); process.exit(1) })
