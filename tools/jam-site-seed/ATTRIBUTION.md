# Media used by `seed.mjs --media`

Everything `fetch-media.mjs` downloads comes from **Wikimedia Commons** and is
labelled **public domain** or **CC0** on its own Commons page. Nothing here is
"free to use" under a custom licence (no Pexels, no Pixabay). The script asks the
Commons API for each file's licence line at download time and refuses any file
whose line is not public domain or CC0.

None of the files is in git: `fetch-media.mjs` writes them to a directory of your
choice (default `tools/jam-site-seed/.media/`, gitignored) and transcodes them
with ffmpeg (covers squared to 720 px, avatars cropped to 384 px, clips cut to 20 s
at 360 lines on the short side, VP8 and Opus in WebM, or H.264 and AAC in MP4
with `--format mp4`).

Notes on the labels:

- The Library of Congress photographs (William P. Gottlieb, 1946 to 1948) and the
  White House, Navy, Army and Bureau of Land Management videos are works of the
  US government or were dedicated to the public domain by their author.
- Paintings, prints and posters are public domain through age; the 1938 posters
  are US government works.
- The Koffermejia, Andy Russell and Rachmaninoff cadenza files are CC0 as
  uploaded. The Korean "Tico Tico" and the accordion orchestra files are marked
  public domain by their uploaders. This table repeats Commons' label, and the
  script re-reads it each time it runs.
- The video parts of a song carry their clip's own sound; audio-only parts keep
  the seed's synthetic tones.
- The portraits are historical figures, used only as avatars of made-up accounts
  in a local test database.

| Use | Local file | Source (Commons page) | Author / credit | Licence | Clip start |
|---|---|---|---|---|---|
| cover | `covers/c01.jpg` | [The Great Wave off Kanagawa.jpg](https://commons.wikimedia.org/wiki/File:The_Great_Wave_off_Kanagawa.jpg) | After Katsushika Hokusai | Public domain | |
| cover | `covers/c02.jpg` | [Vincent van Gogh - Starry Night - Google Art Project.jpg](https://commons.wikimedia.org/wiki/File:Vincent_van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg) | Vincent van Gogh | Public domain | |
| cover | `covers/c03.jpg` | [Mucha-job.jpg](https://commons.wikimedia.org/wiki/File:Mucha-job.jpg) | Alphonse Mucha | Public domain | |
| cover | `covers/c04.jpg` | [Grand Canyon poster 1938.jpg](https://commons.wikimedia.org/wiki/File:Grand_Canyon_poster_1938.jpg) | National Park Service | Public domain | |
| cover | `covers/c05.jpg` | [Hiroshige, Heavy rain on a pine tree.jpg](https://commons.wikimedia.org/wiki/File:Hiroshige,_Heavy_rain_on_a_pine_tree.jpg) | Utagawa Hiroshige | Public domain | |
| cover | `covers/c06.jpg` | [Girl with a Pearl Earring.jpg](https://commons.wikimedia.org/wiki/File:Girl_with_a_Pearl_Earring.jpg) | Johannes Vermeer | Public domain | |
| cover | `covers/c07.jpg` | [The Kiss - Gustav Klimt - Google Cultural Institute.jpg](https://commons.wikimedia.org/wiki/File:The_Kiss_-_Gustav_Klimt_-_Google_Cultural_Institute.jpg) | Gustav Klimt | Public domain | |
| cover | `covers/c08.jpg` | [Edvard Munch - The Scream - Google Art Project.jpg](https://commons.wikimedia.org/wiki/File:Edvard_Munch_-_The_Scream_-_Google_Art_Project.jpg) | Edvard Munch | Public domain | |
| cover | `covers/c09.jpg` | [(Albi) Moulin-rouge. La Goulue et Valentin le desossé - Toulouse-Lautrec 1891 - Inv.138.jpg](https://commons.wikimedia.org/wiki/File:(Albi)_Moulin-rouge._La_Goulue_et_Valentin_le_desoss%C3%A9_-_Toulouse-Lautrec_1891_-_Inv.138.jpg) | Didier Descouens | Public domain | |
| cover | `covers/c10.jpg` | [The national parks preserve wild life, WPA poster, ca. 1938.jpg](https://commons.wikimedia.org/wiki/File:The_national_parks_preserve_wild_life,_WPA_poster,_ca._1938.jpg) | J. Hirt for Work Projects Administration Federal Art Project, New York City | Public domain | |
| cover | `covers/c11.jpg` | [Billie Holiday, Downbeat, New York, N.Y., ca. Feb. 1947 (William P. Gottlieb 04251).jpg](https://commons.wikimedia.org/wiki/File:Billie_Holiday,_Downbeat,_New_York,_N.Y.,_ca._Feb._1947_(William_P._Gottlieb_04251).jpg) | William P. Gottlieb | Public domain | |
| cover | `covers/c12.jpg` | [Claude Monet - Seerosen.jpg](https://commons.wikimedia.org/wiki/File:Claude_Monet_-_Seerosen.jpg) | Claude Monet | Public domain | |
| cover | `covers/c13.jpg` | [(Portrait of Dizzy Gillespie, John Lewis, Cecil Payne, Miles Davis, and Ray Brown, Downbeat, New York, N.Y., between 1946 and 1948) (LOC) (4843129109).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Dizzy_Gillespie,_John_Lewis,_Cecil_Payne,_Miles_Davis,_and_Ray_Brown,_Downbeat,_New_York,_N.Y.,_between_1946_and_1948)_(LOC)_(4843129109).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p1.jpg` | [(Portrait of Count Basie, Aquarium, New York, N.Y., between 1946 and 1948) (LOC) (4843735328).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Count_Basie,_Aquarium,_New_York,_N.Y.,_between_1946_and_1948)_(LOC)_(4843735328).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p2.jpg` | [(Portrait of Lionel Hampton, Aquarium, New York, N.Y., ca. June 1946) (LOC) (4843131247).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Lionel_Hampton,_Aquarium,_New_York,_N.Y.,_ca._June_1946)_(LOC)_(4843131247).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p3.jpg` | [(Portrait of Doris Day, Aquarium, New York, N.Y., ca. July 1946) (LOC) (5268907067).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Doris_Day,_Aquarium,_New_York,_N.Y.,_ca._July_1946)_(LOC)_(5268907067).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p4.jpg` | [(Portrait of Django Reinhardt, Aquarium, New York, N.Y., ca. Nov. 1946) (LOC) (4843142229).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Django_Reinhardt,_Aquarium,_New_York,_N.Y.,_ca._Nov._1946)_(LOC)_(4843142229).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p5.jpg` | [(Portrait of Oscar Pettiford, Aquarium, New York, N.Y., ca. Nov. 1946) (LOC) (4843755904).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Oscar_Pettiford,_Aquarium,_New_York,_N.Y.,_ca._Nov._1946)_(LOC)_(4843755904).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p6.jpg` | [(Portrait of Mildred Bailey, Aquarium, New York, N.Y., ca. Aug. 1946) (LOC) (4888657750).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Mildred_Bailey,_Aquarium,_New_York,_N.Y.,_ca._Aug._1946)_(LOC)_(4888657750).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p7.jpg` | [(Portrait of Art Tatum, Rochester, N.Y.(?), ca. May 1946) (LOC) (5148796890).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Art_Tatum,_Rochester,_N.Y.(%3F),_ca._May_1946)_(LOC)_(5148796890).jpg) | The Library of Congress | Public domain | |
| avatar | `portraits/p8.jpg` | [(Portrait of Chubby Jackson, Downbeat, New York, N.Y., ca. Nov. 1946) (LOC) (5354783618).jpg](https://commons.wikimedia.org/wiki/File:(Portrait_of_Chubby_Jackson,_Downbeat,_New_York,_N.Y.,_ca._Nov._1946)_(LOC)_(5354783618).jpg) | The Library of Congress | Public domain | |
| video | `clips/drums-street.webm` | [Street drummer in Portland, Oregon.webm](https://commons.wikimedia.org/wiki/File:Street_drummer_in_Portland,_Oregon.webm) | Kingofthedead | Public domain | 6s |
| video | `clips/drums-russell.webm` | [Andy Russell Drum Solo from The Stork Club 1945.ogv](https://commons.wikimedia.org/wiki/File:Andy_Russell_Drum_Solo_from_The_Stork_Club_1945.ogv) | B.G. DeSylva Productions Inc | CC0 | 25s |
| video | `clips/bass-spalding.webm` | [Esperanza Spalding Performs at the White House Poetry Jam- (5 of 8).webm](https://commons.wikimedia.org/wiki/File:Esperanza_Spalding_Performs_at_the_White_House_Poetry_Jam-_(5_of_8).webm) | The White House | Public domain | 45s |
| video | `clips/guitar-ticotico.webm` | [티코티코(우쿨렐레,카혼,기타)-Tico Tico(ukulele,cajon,guitar).webm](https://commons.wikimedia.org/wiki/File:%ED%8B%B0%EC%BD%94%ED%8B%B0%EC%BD%94(%EC%9A%B0%EC%BF%A8%EB%A0%90%EB%A0%88,%EC%B9%B4%ED%98%BC,%EA%B8%B0%ED%83%80)-Tico_Tico(ukulele,cajon,guitar).webm) | 한형일 | Public domain | 6s |
| video | `clips/guitar-isbin.webm` | [20091104 Sharon Isbin - Isaac Albéniz's Asturias.ogv](https://commons.wikimedia.org/wiki/File:20091104_Sharon_Isbin_-_Isaac_Alb%C3%A9niz%27s_Asturias.ogv) | Isaac Albéniz (1860 - 1909), composer. Video by White House (edited by myself), music originally for piano by Isaac Albé | Public domain | 40s |
| video | `clips/guitar-requinto.webm` | [Octavio Vega clase de requinto.webm](https://commons.wikimedia.org/wiki/File:Octavio_Vega_clase_de_requinto.webm) | Koffermejia | CC0 | 0s |
| video | `clips/guitar-bernal.webm` | [Los hermanos Bernal tocando el Palomo, Un son jarocho.webm](https://commons.wikimedia.org/wiki/File:Los_hermanos_Bernal_tocando_el_Palomo,_Un_son_jarocho.webm) | Koffermejia | CC0 | 8s |
| video | `clips/guitar-ukulele.webm` | [Ukulele jam session at Table Rocks (42261446172).webm](https://commons.wikimedia.org/wiki/File:Ukulele_jam_session_at_Table_Rocks_(42261446172).webm) | BLM Oregon & Washington | Public domain | 6s |
| video | `clips/vocals-jolson.webm` | [Sonny Boy (The Singing Fool clip, Jolson).webm](https://commons.wikimedia.org/wiki/File:Sonny_Boy_(The_Singing_Fool_clip,_Jolson).webm) | Lloyd Bacon and Al Jolson | Public domain | 25s |
| video | `clips/vocals-mojado.webm` | [Grupo mojado tocando Piensa en mi.webm](https://commons.wikimedia.org/wiki/File:Grupo_mojado_tocando_Piensa_en_mi.webm) | Koffermejia | CC0 | 0s |
| video | `clips/vocals-spalding.webm` | [Esperanza Spalding Performs at the White House Poetry Jam- (5 of 8).webm](https://commons.wikimedia.org/wiki/File:Esperanza_Spalding_Performs_at_the_White_House_Poetry_Jam-_(5_of_8).webm) | The White House | Public domain | 120s |
| video | `clips/keys-pratt.webm` | [Awadagin Pratt Performs at the White House- 2 of 8.webm](https://commons.wikimedia.org/wiki/File:Awadagin_Pratt_Performs_at_the_White_House-_2_of_8.webm) | The White House | Public domain | 90s |
| video | `clips/keys-rachmaninoff.webm` | [Rachmaninoff Piano Concerto No. 3 Ossia Cadenza.webm](https://commons.wikimedia.org/wiki/File:Rachmaninoff_Piano_Concerto_No._3_Ossia_Cadenza.webm) | CanadaPiano1998 | CC0 | 12s |
| video | `clips/other-wind.webm` | [Anchors Aweigh by 215th Army Band's "Liberty Winds".webm](https://commons.wikimedia.org/wiki/File:Anchors_Aweigh_by_215th_Army_Band%27s_%22Liberty_Winds%22.webm) | U.S. Army SGT Ryan Fossier - French Horn SGT Brenton Webster - Baritone Saxophone SGT Bernard McNamara - Clarinet SPC Mi | Public domain | 6s |
| video | `clips/other-cello.webm` | [20091104 Alisa Weilerstein and Jason Yoder - Saint Saëns' The Swan.ogv](https://commons.wikimedia.org/wiki/File:20091104_Alisa_Weilerstein_and_Jason_Yoder_-_Saint_Sa%C3%ABns%27_The_Swan.ogv) | Camille Saint-Saëns | Public domain | 30s |
| video | `clips/other-accordion.webm` | [Akkordeonorchester Hof - Tritsch-Tratsch Polka.webm](https://commons.wikimedia.org/wiki/File:Akkordeonorchester_Hof_-_Tritsch-Tratsch_Polka.webm) | Aufführung: Akkordeonorchester Hof (aohof) / Komponist: Johann Strauss Sohn | Public domain | 12s |
| video | `clips/other-jarocho.webm` | [Enarmonia tocando son jarocho en el escenario.webm](https://commons.wikimedia.org/wiki/File:Enarmonia_tocando_son_jarocho_en_el_escenario.webm) | Koffermejia | CC0 | 6s |
| video | `clips/other-harp.webm` | [Harpo Marx performs "When My Dreams come True" (1929 Cocoanuts).webm](https://commons.wikimedia.org/wiki/File:Harpo_Marx_performs_%22When_My_Dreams_come_True%22_(1929_Cocoanuts).webm) | Harpo Marx | Public domain | 40s |
