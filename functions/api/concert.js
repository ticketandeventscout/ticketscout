// ===========================
// TicketScout — Concert artist page handler
// Runs as a Cloudflare Pages Function at /api/concert
//
// Called by the concert template (concert.html) on page load.
// Returns artist data + Ticketmaster attraction ID for the requested slug.
//
// Usage: GET /api/concert?slug=coldplay
// Returns: { artist: {...}, attractionId: "K8vZ917..." } or { error: "..." }
// ===========================

// Artist data — inlined here to avoid ES module import issues in Pages Functions
// Keep in sync with concert-data.js at the project root
const ARTISTS = [
  { slug: 'coldplay',            name: 'Coldplay',            search: 'Coldplay',            genre: 'Rock / Pop',                   description: 'Coldplay are one of the best-selling music artists of all time, known for their anthemic rock sound and spectacular live shows. The British band have sold over 100 million records worldwide and are renowned for their colourful, immersive concerts featuring LED wristbands and confetti cannons.' },
  { slug: 'ed-sheeran',         name: 'Ed Sheeran',          search: 'Ed Sheeran',          genre: 'Pop',                          description: 'Ed Sheeran is one of the UK\'s most successful artists, known for his acoustic-driven pop sound and record-breaking world tours. With multiple Grammy Awards and Brit Awards to his name, his live shows are celebrated for their intimate atmosphere despite playing to stadium-sized crowds.' },
  { slug: 'metallica',          name: 'Metallica',           search: 'Metallica',           genre: 'Heavy Metal',                  description: 'Metallica are one of the most influential heavy metal bands in history, having sold over 125 million records worldwide. Their M72 World Tour is one of the highest-grossing tours of all time, featuring a unique in-the-round stage design with no barricade between the band and the audience.' },
  { slug: 'foo-fighters',       name: 'Foo Fighters',        search: 'Foo Fighters',        genre: 'Rock',                         description: 'Foo Fighters are one of the world\'s biggest rock bands, led by Nirvana drummer Dave Grohl. Known for their energetic and marathon live performances, the band have won 12 Grammy Awards and are a fixture at major festivals and arenas worldwide.' },
  { slug: 'bad-bunny',          name: 'Bad Bunny',           search: 'Bad Bunny',           genre: 'Latin Trap / Reggaeton',       description: 'Bad Bunny is a Puerto Rican singer, rapper and songwriter who has become one of the world\'s most streamed artists. His Most Wanted Tour broke multiple box office records and his theatrical, immersive concerts are among the most sought-after live events globally.' },
  { slug: 'the-weeknd',         name: 'The Weeknd',          search: 'The Weeknd',          genre: 'R&B / Pop',                    description: 'The Weeknd is a Canadian singer, songwriter and record producer known for his distinctive sound blending R&B, pop and synth-wave. His After Hours Til Dawn Tour became one of the highest-grossing concert tours of all time.' },
  { slug: 'ariana-grande',      name: 'Ariana Grande',       search: 'Ariana Grande',       genre: 'Pop / R&B',                    description: 'Ariana Grande is one of the world\'s best-selling music artists, known for her powerful vocal range and high-energy pop performances. With multiple chart-topping albums and record-breaking streaming numbers, her live shows are among the most anticipated events in pop music.' },
  { slug: 'bruno-mars',         name: 'Bruno Mars',          search: 'Bruno Mars',          genre: 'Pop / R&B / Funk',             description: 'Bruno Mars is a Grammy Award-winning singer, songwriter and producer known for his dynamic stage presence and genre-spanning sound. His live performances, which blend pop, funk, R&B and soul, are widely considered among the most entertaining in the industry.' },
  { slug: 'taylor-swift',       name: 'Taylor Swift',        search: 'Taylor Swift',        genre: 'Pop / Country',                description: 'Taylor Swift is one of the most celebrated musicians of her generation, known for her songwriting, record-breaking album releases and the phenomenon of the Eras Tour — the highest-grossing concert tour of all time.' },
  { slug: 'doja-cat',           name: 'Doja Cat',            search: 'Doja Cat',            genre: 'Hip-Hop / Pop / R&B',          description: 'Doja Cat is an American rapper, singer and songwriter known for her genre-blending sound and visually creative live performances. Her Scarlet Tour brought an elaborate theatrical production to arenas worldwide.' },
  { slug: 'tame-impala',        name: 'Tame Impala',         search: 'Tame Impala',         genre: 'Psychedelic Rock / Electronic', description: 'Tame Impala is an Australian psychedelic rock project led by Kevin Parker, known for its immersive visual shows and critically acclaimed albums. Their concert productions are celebrated for combining stunning light shows with a hypnotic, textured sound.' },
  { slug: 'my-chemical-romance', name: 'My Chemical Romance', search: 'My Chemical Romance', genre: 'Alternative Rock / Emo',       description: 'My Chemical Romance are an iconic American rock band known for their theatrical performances and devoted global fanbase. Following their 2019 reunion, the band have returned to selling out major venues and festivals worldwide.' },
  { slug: 'wolf-alice',         name: 'Wolf Alice',          search: 'Wolf Alice',          genre: 'Alternative Rock / Indie',     description: 'Wolf Alice are a British rock band and Mercury Prize winners known for their dynamic range — from delicate acoustic moments to full-throttle guitar rock. One of the most critically acclaimed British bands of their generation.' },
  { slug: 'biffy-clyro',        name: 'Biffy Clyro',         search: 'Biffy Clyro',         genre: 'Alternative Rock',             description: 'Biffy Clyro are a Scottish rock band known for their complex song structures, powerful live performances and loyal fanbase. Multiple Brit Award nominees, they regularly headline major UK arenas and festivals.' },
  { slug: 'the-1975',           name: 'The 1975',            search: 'The 1975',            genre: 'Indie Pop / Alternative Rock',  description: 'The 1975 are a British pop-rock band known for their genre-fluid sound and elaborate theatrical live productions. Fronted by Matty Healy, their shows are celebrated as cultural events combining provocative visuals and introspective lyrics.' },
  { slug: 'a-christmas-carol', name: 'A Christmas Carol', search: 'A Christmas Carol', genre: 'Live Events', description: 'Compare A Christmas Carol ticket prices across verified sellers.' },
  { slug: 'little-shop-of-horrors', name: 'Little Shop Of Horrors', search: 'Little Shop Of Horrors', genre: 'Live Events', description: 'Compare Little Shop Of Horrors ticket prices across verified sellers.' },
  { slug: 'maybe-happy-ending', name: 'Maybe Happy Ending', search: 'Maybe Happy Ending', genre: 'Live Events', description: 'Compare Maybe Happy Ending ticket prices across verified sellers.' },
  { slug: 'buena-vista-social-club', name: 'Buena Vista Social Club', search: 'Buena Vista Social Club', genre: 'Live Events', description: 'Compare Buena Vista Social Club ticket prices across verified sellers.' },
  { slug: 'blue-man-group', name: 'Blue Man Group', search: 'Blue Man Group', genre: 'Live Events', description: 'Compare Blue Man Group ticket prices across verified sellers.' },
  { slug: 'magic-mike-live', name: 'Magic Mike Live', search: 'Magic Mike Live', genre: 'Live Events', description: 'Compare Magic Mike Live ticket prices across verified sellers.' },
  { slug: 'jabbawockeez', name: 'Jabbawockeez', search: 'Jabbawockeez', genre: 'Live Events', description: 'Compare Jabbawockeez ticket prices across verified sellers.' },
  { slug: 'dolly', name: 'Dolly', search: 'Dolly', genre: 'Live Events', description: 'Compare Dolly ticket prices across verified sellers.' },
  { slug: 'all-motown', name: 'All Motown', search: 'All Motown', genre: 'Live Events', description: 'Compare All Motown ticket prices across verified sellers.' },
  { slug: 'all-shook-up', name: 'All Shook Up', search: 'All Shook Up', genre: 'Live Events', description: 'Compare All Shook Up ticket prices across verified sellers.' },
  { slug: 'candlelight', name: 'Candlelight', search: 'Candlelight', genre: 'Live Events', description: 'Compare Candlelight ticket prices across verified sellers.' },
  { slug: 'death-becomes-her', name: 'Death Becomes Her', search: 'Death Becomes Her', genre: 'Live Events', description: 'Compare Death Becomes Her ticket prices across verified sellers.' },
  { slug: 'comedy-cellar', name: 'Comedy Cellar', search: 'Comedy Cellar', genre: 'Live Events', description: 'Compare Comedy Cellar ticket prices across verified sellers.' },
  { slug: 'beetlejuice', name: 'Beetlejuice', search: 'Beetlejuice', genre: 'Live Events', description: 'Compare Beetlejuice ticket prices across verified sellers.' },
  { slug: 'evita', name: 'Evita', search: 'Evita', genre: 'Live Events', description: 'Compare Evita ticket prices across verified sellers.' },
  { slug: 'hells-kitchen', name: 'Hells Kitchen', search: 'Hells Kitchen', genre: 'Live Events', description: 'Compare Hells Kitchen ticket prices across verified sellers.' },
  { slug: 'matilda', name: 'Matilda', search: 'Matilda', genre: 'Live Events', description: 'Compare Matilda ticket prices across verified sellers.' },
  { slug: 'daniel', name: 'Daniel', search: 'Daniel', genre: 'Live Events', description: 'Compare Daniel ticket prices across verified sellers.' },
  { slug: 'juliet', name: 'Juliet', search: 'Juliet', genre: 'Live Events', description: 'Compare Juliet ticket prices across verified sellers.' },
  { slug: 'annie', name: 'Annie', search: 'Annie', genre: 'Live Events', description: 'Compare Annie ticket prices across verified sellers.' },
  { slug: 'mat-franco', name: 'Mat Franco', search: 'Mat Franco', genre: 'Live Events', description: 'Compare Mat Franco ticket prices across verified sellers.' },
  { slug: 'hairspray', name: 'Hairspray', search: 'Hairspray', genre: 'Live Events', description: 'Compare Hairspray ticket prices across verified sellers.' },
  { slug: 'disney-on-ice', name: 'Disney On Ice', search: 'Disney On Ice', genre: 'Live Events', description: 'Compare Disney On Ice ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-ka', name: 'Cirque Du Soleil Ka', search: 'Cirque Du Soleil Ka', genre: 'Live Events', description: 'Compare Cirque Du Soleil Ka ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-mystere', name: 'Cirque Du Soleil Mystere', search: 'Cirque Du Soleil Mystere', genre: 'Live Events', description: 'Compare Cirque Du Soleil Mystere ticket prices across verified sellers.' },
  { slug: 'galileo', name: 'Galileo', search: 'Galileo', genre: 'Live Events', description: 'Compare Galileo ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-auana', name: 'Cirque Du Soleil Auana', search: 'Cirque Du Soleil Auana', genre: 'Live Events', description: 'Compare Cirque Du Soleil Auana ticket prices across verified sellers.' },
  { slug: 'garden-brothers-nuclear-circus', name: 'Garden Brothers Nuclear Circus', search: 'Garden Brothers Nuclear Circus', genre: 'Live Events', description: 'Compare Garden Brothers Nuclear Circus ticket prices across verified sellers.' },
  { slug: 'christmas-spectacular-starring-the-radio-city-rockettes', name: 'Christmas Spectacular Starring The Radio City Rockettes', search: 'Christmas Spectacular Starring The Radio City Rockettes', genre: 'Live Events', description: 'Compare Christmas Spectacular Starring The Radio City Rockettes ticket prices across verified sellers.' },
  { slug: 'eddie-griffin', name: 'Eddie Griffin', search: 'Eddie Griffin', genre: 'Live Events', description: 'Compare Eddie Griffin ticket prices across verified sellers.' },
  { slug: 'grand-shanghai-circus', name: 'Grand Shanghai Circus', search: 'Grand Shanghai Circus', genre: 'Live Events', description: 'Compare Grand Shanghai Circus ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-mad-apple', name: 'Cirque Du Soleil Mad Apple', search: 'Cirque Du Soleil Mad Apple', genre: 'Live Events', description: 'Compare Cirque Du Soleil Mad Apple ticket prices across verified sellers.' },
  { slug: 'cats', name: 'Cats', search: 'Cats', genre: 'Live Events', description: 'Compare Cats ticket prices across verified sellers.' },
  { slug: 'beauty-and-the-beast', name: 'Beauty And The Beast', search: 'Beauty And The Beast', genre: 'Live Events', description: 'Compare Beauty And The Beast ticket prices across verified sellers.' },
  { slug: 'chippendales', name: 'Chippendales', search: 'Chippendales', genre: 'Live Events', description: 'Compare Chippendales ticket prices across verified sellers.' },
  { slug: 'laugh-factory', name: 'Laugh Factory', search: 'Laugh Factory', genre: 'Live Events', description: 'Compare Laugh Factory ticket prices across verified sellers.' },
  { slug: 'big-black-comedy-show', name: 'Big Black Comedy Show', search: 'Big Black Comedy Show', genre: 'Live Events', description: 'Compare Big Black Comedy Show ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-o', name: 'Cirque Du Soleil O', search: 'Cirque Du Soleil O', genre: 'Live Events', description: 'Compare Cirque Du Soleil O ticket prices across verified sellers.' },
  { slug: 'aladdin', name: 'Aladdin', search: 'Aladdin', genre: 'Live Events', description: 'Compare Aladdin ticket prices across verified sellers.' },
  { slug: 'jamie-allans-amaze', name: 'Jamie Allans Amaze', search: 'Jamie Allans Amaze', genre: 'Live Events', description: 'Compare Jamie Allans Amaze ticket prices across verified sellers.' },
  { slug: 'adam-london-laughternoon', name: 'Adam London Laughternoon', search: 'Adam London Laughternoon', genre: 'Live Events', description: 'Compare Adam London Laughternoon ticket prices across verified sellers.' },
  { slug: 'metropolitan-opera', name: 'Metropolitan Opera', search: 'Metropolitan Opera', genre: 'Live Events', description: 'Compare Metropolitan Opera ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-drawn-to-life', name: 'Cirque Du Soleil Drawn To Life', search: 'Cirque Du Soleil Drawn To Life', genre: 'Live Events', description: 'Compare Cirque Du Soleil Drawn To Life ticket prices across verified sellers.' },
  { slug: 'just-in-time', name: 'Just In Time', search: 'Just In Time', genre: 'Live Events', description: 'Compare Just In Time ticket prices across verified sellers.' },
  { slug: 'mean-girls', name: 'Mean Girls', search: 'Mean Girls', genre: 'Live Events', description: 'Compare Mean Girls ticket prices across verified sellers.' },
  { slug: 'drunk-pirates', name: 'Drunk Pirates', search: 'Drunk Pirates', genre: 'Live Events', description: 'Compare Drunk Pirates ticket prices across verified sellers.' },
  { slug: 'blueys-big-play', name: 'Blueys Big Play', search: 'Blueys Big Play', genre: 'Live Events', description: 'Compare Blueys Big Play ticket prices across verified sellers.' },
  { slug: 'joseph-and-the-amazing-technicolor-dreamcoat', name: 'Joseph And The Amazing Technicolor Dreamcoat', search: 'Joseph And The Amazing Technicolor Dreamcoat', genre: 'Live Events', description: 'Compare Joseph And The Amazing Technicolor Dreamcoat ticket prices across verified sellers.' },
  { slug: 'la-comedy-club', name: 'La Comedy Club', search: 'La Comedy Club', genre: 'Live Events', description: 'Compare La Comedy Club ticket prices across verified sellers.' },
  { slug: 'a-beautiful-noise', name: 'A Beautiful Noise', search: 'A Beautiful Noise', genre: 'Live Events', description: 'Compare A Beautiful Noise ticket prices across verified sellers.' },
  { slug: 'boop-the-musical', name: 'Boop The Musical', search: 'Boop The Musical', genre: 'Live Events', description: 'Compare Boop The Musical ticket prices across verified sellers.' },
  { slug: 'menopause-the-musical', name: 'Menopause The Musical', search: 'Menopause The Musical', genre: 'Live Events', description: 'Compare Menopause The Musical ticket prices across verified sellers.' },
  { slug: 'le-grand-cirque', name: 'Le Grand Cirque', search: 'Le Grand Cirque', genre: 'Live Events', description: 'Compare Le Grand Cirque ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-michael-jackson-one', name: 'Cirque Du Soleil Michael Jackson One', search: 'Cirque Du Soleil Michael Jackson One', genre: 'Live Events', description: 'Compare Cirque Du Soleil Michael Jackson One ticket prices across verified sellers.' },
  { slug: 'heathers', name: 'Heathers', search: 'Heathers', genre: 'Live Events', description: 'Compare Heathers ticket prices across verified sellers.' },
  { slug: 'legends-in-concert', name: 'Legends In Concert', search: 'Legends In Concert', genre: 'Live Events', description: 'Compare Legends In Concert ticket prices across verified sellers.' },
  { slug: 'cirque-du-soleil-luzia', name: 'Cirque Du Soleil Luzia', search: 'Cirque Du Soleil Luzia', genre: 'Live Events', description: 'Compare Cirque Du Soleil Luzia ticket prices across verified sellers.' },
  { slug: 'delirious-comedy-club', name: 'Delirious Comedy Club', search: 'Delirious Comedy Club', genre: 'Live Events', description: 'Compare Delirious Comedy Club ticket prices across verified sellers.' },
  { slug: 'circus-vazquez', name: 'Circus Vazquez', search: 'Circus Vazquez', genre: 'Live Events', description: 'Compare Circus Vazquez ticket prices across verified sellers.' },
  { slug: 'joshua', name: 'Joshua', search: 'Joshua', genre: 'Live Events', description: 'Compare Joshua ticket prices across verified sellers.' },
  { slug: 'an-r-rated-magic-show', name: 'An R Rated Magic Show', search: 'An R Rated Magic Show', genre: 'Live Events', description: 'Compare An R Rated Magic Show ticket prices across verified sellers.' },
  { slug: 'los-angeles-philharmonic', name: 'Los Angeles Philharmonic', search: 'Los Angeles Philharmonic', genre: 'Live Events', description: 'Compare Los Angeles Philharmonic ticket prices across verified sellers.' },
  { slug: 'chicago-architecture-center-river-cruise', name: 'Chicago Architecture Center River Cruise', search: 'Chicago Architecture Center River Cruise', genre: 'Live Events', description: 'Compare Chicago Architecture Center River Cruise ticket prices across verified sellers.' },
  { slug: 'beautiful', name: 'Beautiful', search: 'Beautiful', genre: 'Live Events', description: 'Compare Beautiful ticket prices across verified sellers.' },
  { slug: 'how-the-grinch-stole-christmas', name: 'How The Grinch Stole Christmas', search: 'How The Grinch Stole Christmas', genre: 'Live Events', description: 'Compare How The Grinch Stole Christmas ticket prices across verified sellers.' },
  { slug: 'carrot-top', name: 'Carrot Top', search: 'Carrot Top', genre: 'Live Events', description: 'Compare Carrot Top ticket prices across verified sellers.' },
  { slug: 'anastasia', name: 'Anastasia', search: 'Anastasia', genre: 'Live Events', description: 'Compare Anastasia ticket prices across verified sellers.' },
  { slug: 'david-goldrake', name: 'David Goldrake', search: 'David Goldrake', genre: 'Live Events', description: 'Compare David Goldrake ticket prices across verified sellers.' },
  { slug: 'the-wizard-of-oz', name: 'The Wizard Of Oz', search: 'The Wizard Of Oz', genre: 'Live Events', description: 'Compare The Wizard Of Oz ticket prices across verified sellers.' },
  { slug: 'garden-bros-nuclear-circus', name: 'Garden Bros Nuclear Circus', search: 'Garden Bros Nuclear Circus', genre: 'Live Events', description: 'Compare Garden Bros Nuclear Circus ticket prices across verified sellers.' },
  { slug: 'second-city-mainstage-revue', name: 'Second City Mainstage Revue', search: 'Second City Mainstage Revue', genre: 'Live Events', description: 'Compare Second City Mainstage Revue ticket prices across verified sellers.' },
  { slug: 'piano-man', name: 'Piano Man', search: 'Piano Man', genre: 'Live Events', description: 'Compare Piano Man ticket prices across verified sellers.' },
  { slug: 'radio-city-christmas-spectacular', name: 'Radio City Christmas Spectacular', search: 'Radio City Christmas Spectacular', genre: 'Live Events', description: 'Compare Radio City Christmas Spectacular ticket prices across verified sellers.' },
  { slug: 'shanghai-circus', name: 'Shanghai Circus', search: 'Shanghai Circus', genre: 'Live Events', description: 'Compare Shanghai Circus ticket prices across verified sellers.' },
  { slug: 'the-empire-strips-back', name: 'The Empire Strips Back', search: 'The Empire Strips Back', genre: 'Live Events', description: 'Compare The Empire Strips Back ticket prices across verified sellers.' },
  { slug: 'piff-the-magic-dragon', name: 'Piff The Magic Dragon', search: 'Piff The Magic Dragon', genre: 'Live Events', description: 'Compare Piff The Magic Dragon ticket prices across verified sellers.' },
  { slug: 'venardos-circus', name: 'Venardos Circus', search: 'Venardos Circus', genre: 'Live Events', description: 'Compare Venardos Circus ticket prices across verified sellers.' },
  { slug: 'rupauls-drag-race', name: 'Rupauls Drag Race', search: 'Rupauls Drag Race', genre: 'Live Events', description: 'Compare Rupauls Drag Race ticket prices across verified sellers.' }
  { slug: 'ceilidh', name: 'Ceilidh', search: 'Ceilidh', genre: 'Live Music', description: 'Ceilidh are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-seven-deadly-sins-the-human-voice', name: 'The Seven Deadly Sins / The Human Voice', search: 'The Seven Deadly Sins / The Human Voice', genre: 'Live Music', description: 'The Seven Deadly Sins / The Human Voice are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-wombats', name: 'The Wombats', search: 'The Wombats', genre: 'Live Music', description: 'The Wombats are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ludovico-einaudi', name: 'Ludovico Einaudi', search: 'Ludovico Einaudi', genre: 'Live Music', description: 'Ludovico Einaudi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'amble', name: 'Amble', search: 'Amble', genre: 'Live Music', description: 'Amble are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'pitbull', name: 'Pitbull', search: 'Pitbull', genre: 'Live Music', description: 'Pitbull are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rob-beckett', name: 'Rob Beckett (15+ Event)', search: 'Rob Beckett (15+ Event)', genre: 'Live Music', description: 'Rob Beckett (15+ Event) are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'andrea-bocelli', name: 'Andrea Bocelli', search: 'Andrea Bocelli', genre: 'Live Music', description: 'Andrea Bocelli are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'atlanta-falcons-at-tampa-bay-buccaneers', name: 'Atlanta Falcons at Tampa Bay Buccaneers (Thursday Night Football)', search: 'Atlanta Falcons at Tampa Bay Buccaneers (Thursday Night Football)', genre: 'Sports', description: 'Atlanta Falcons at Tampa Bay Buccaneers (Thursday Night Football) are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'amy-macdonald', name: 'Amy Macdonald', search: 'Amy Macdonald', genre: 'Live Music', description: 'Amy Macdonald are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'pentatonix', name: 'Pentatonix', search: 'Pentatonix', genre: 'Live Music', description: 'Pentatonix are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'robert-plant', name: 'Robert Plant', search: 'Robert Plant', genre: 'Live Music', description: 'Robert Plant are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207-stuttgart', name: 'Apache 207 Stuttgart', search: 'Apache 207 Stuttgart', genre: 'Live Music', description: 'Apache 207 Stuttgart are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jamiroquai', name: 'Jamiroquai', search: 'Jamiroquai', genre: 'Live Music', description: 'Jamiroquai are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ice-nine-kills-london', name: 'Ice Nine Kills London', search: 'Ice Nine Kills London', genre: 'Live Music', description: 'Ice Nine Kills London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jamie-cullum-london', name: 'Jamie Cullum London', search: 'Jamie Cullum London', genre: 'Live Music', description: 'Jamie Cullum London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lady-gaga-the-mayhem-ball', name: 'Lady Gaga: The MAYHEM Ball', search: 'Lady Gaga: The MAYHEM Ball', genre: 'Live Music', description: 'Lady Gaga: The MAYHEM Ball are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'elvana', name: 'Elvana', search: 'Elvana', genre: 'Live Music', description: 'Elvana are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-fitipaldis-pamplona', name: 'Fito & Fitipaldis Pamplona', search: 'Fito & Fitipaldis Pamplona', genre: 'Live Music', description: 'Fito & Fitipaldis Pamplona are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'slade-liverpool', name: 'Slade Liverpool', search: 'Slade Liverpool', genre: 'Live Music', description: 'Slade Liverpool are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'salmo', name: 'Salmo', search: 'Salmo', genre: 'Live Music', description: 'Salmo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'marracash', name: 'Marracash', search: 'Marracash', genre: 'Live Music', description: 'Marracash are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'katseye', name: 'Katseye', search: 'Katseye', genre: 'Live Music', description: 'Katseye are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-round-one', name: 'World Darts Championship: Round One', search: 'World Darts Championship: Round One', genre: 'Sports', description: 'World Darts Championship: Round One are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'band-of-skulls-birmingham', name: 'Band of Skulls Birmingham', search: 'Band of Skulls Birmingham', genre: 'Live Music', description: 'Band of Skulls Birmingham are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bad-omens-amsterdam', name: 'Bad Omens Amsterdam', search: 'Bad Omens Amsterdam', genre: 'Live Music', description: 'Bad Omens Amsterdam are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sg-lewis', name: 'SG Lewis', search: 'SG Lewis', genre: 'Live Music', description: 'SG Lewis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-band-camino-london', name: 'The Band Camino London', search: 'The Band Camino London', genre: 'Live Music', description: 'The Band Camino London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'kneecap', name: 'Kneecap', search: 'Kneecap', genre: 'Live Music', description: 'Kneecap are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'riverdance', name: 'Riverdance', search: 'Riverdance', genre: 'Live Music', description: 'Riverdance are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sido', name: 'Sido', search: 'Sido', genre: 'Live Music', description: 'Sido are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'andr-rieu', name: 'André Rieu', search: 'André Rieu', genre: 'Live Music', description: 'André Rieu are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'giorgia', name: 'Giorgia', search: 'Giorgia', genre: 'Live Music', description: 'Giorgia are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bowling-for-soup-london', name: 'Bowling For Soup London', search: 'Bowling For Soup London', genre: 'Live Music', description: 'Bowling For Soup London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cian-ducrot-birmingham', name: 'Cian Ducrot Birmingham', search: 'Cian Ducrot Birmingham', genre: 'Live Music', description: 'Cian Ducrot Birmingham are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gladiators-live', name: 'Gladiators Live', search: 'Gladiators Live', genre: 'Live Music', description: 'Gladiators Live are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-fitipaldis-zaragoza', name: 'Fito & Fitipaldis Zaragoza', search: 'Fito & Fitipaldis Zaragoza', genre: 'Live Music', description: 'Fito & Fitipaldis Zaragoza are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'morgan-jay', name: 'Morgan Jay', search: 'Morgan Jay', genre: 'Live Music', description: 'Morgan Jay are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'black-coffee', name: 'Black Coffee', search: 'Black Coffee', genre: 'Live Music', description: 'Black Coffee are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-elite-wrestling-collision', name: 'All Elite Wrestling: Collision', search: 'All Elite Wrestling: Collision', genre: 'Sports', description: 'All Elite Wrestling: Collision are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ricky-martin', name: 'Ricky Martin', search: 'Ricky Martin', genre: 'Live Music', description: 'Ricky Martin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'pvris', name: 'PVRIS', search: 'PVRIS', genre: 'Live Music', description: 'PVRIS are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'oneus-london', name: 'Oneus London', search: 'Oneus London', genre: 'Live Music', description: 'Oneus London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'matt-berninger', name: 'Matt Berninger', search: 'Matt Berninger', genre: 'Live Music', description: 'Matt Berninger are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'kingfishr', name: 'Kingfishr', search: 'Kingfishr', genre: 'Live Music', description: 'Kingfishr are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ben-barnes', name: 'Ben Barnes', search: 'Ben Barnes', genre: 'Live Music', description: 'Ben Barnes are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'j-balvin', name: 'J Balvin', search: 'J Balvin', genre: 'Live Music', description: 'J Balvin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dani-martn', name: 'Dani Martín', search: 'Dani Martín', genre: 'Live Music', description: 'Dani Martín are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'matt-rife', name: 'Matt Rife', search: 'Matt Rife', genre: 'Live Music', description: 'Matt Rife are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cian-ducrot-bristol', name: 'Cian Ducrot Bristol', search: 'Cian Ducrot Bristol', genre: 'Live Music', description: 'Cian Ducrot Bristol are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'indianapolis-colts-at-seattle-seahawks', name: 'Indianapolis Colts at Seattle Seahawks', search: 'Indianapolis Colts at Seattle Seahawks', genre: 'Sports', description: 'Indianapolis Colts at Seattle Seahawks are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'green-bay-packers-at-denver-broncos', name: 'Green Bay Packers at Denver Broncos', search: 'Green Bay Packers at Denver Broncos', genre: 'Sports', description: 'Green Bay Packers at Denver Broncos are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'las-vegas-raiders-at-philadelphia-eagles', name: 'Las Vegas Raiders at Philadelphia Eagles', search: 'Las Vegas Raiders at Philadelphia Eagles', genre: 'Sports', description: 'Las Vegas Raiders at Philadelphia Eagles are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'detroit-lions-at-los-angeles-rams', name: 'Detroit Lions at Los Angeles Rams', search: 'Detroit Lions at Los Angeles Rams', genre: 'Sports', description: 'Detroit Lions at Los Angeles Rams are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'buffalo-bills-at-new-england-patriots', name: 'Buffalo Bills at New England Patriots', search: 'Buffalo Bills at New England Patriots', genre: 'Sports', description: 'Buffalo Bills at New England Patriots are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'neck-deep-leeds', name: 'Neck Deep Leeds', search: 'Neck Deep Leeds', genre: 'Live Music', description: 'Neck Deep Leeds are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'acdc-brisbane', name: 'AC/DC Brisbane', search: 'AC/DC Brisbane', genre: 'Live Music', description: 'AC/DC Brisbane are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rnb-xmas-ball', name: 'RnB Xmas Ball', search: 'RnB Xmas Ball', genre: 'Live Music', description: 'RnB Xmas Ball are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'doves-london', name: 'Doves London', search: 'Doves London', genre: 'Live Music', description: 'Doves London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'band-of-skulls', name: 'Band of Skulls', search: 'Band of Skulls', genre: 'Live Music', description: 'Band of Skulls are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'clutch', name: 'Clutch', search: 'Clutch', genre: 'Live Music', description: 'Clutch are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'doves-bournemouth', name: 'Doves Bournemouth', search: 'Doves Bournemouth', genre: 'Live Music', description: 'Doves Bournemouth are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'oneus-cologne', name: 'Oneus Cologne', search: 'Oneus Cologne', genre: 'Live Music', description: 'Oneus Cologne are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207-munich', name: 'Apache 207 Munich', search: 'Apache 207 Munich', genre: 'Live Music', description: 'Apache 207 Munich are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'damiano-david', name: 'Damiano David', search: 'Damiano David', genre: 'Live Music', description: 'Damiano David are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tony-hadley', name: 'Tony Hadley', search: 'Tony Hadley', genre: 'Live Music', description: 'Tony Hadley are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'il-volo', name: 'Il Volo', search: 'Il Volo', genre: 'Live Music', description: 'Il Volo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cian-ducrot', name: 'Cian Ducrot', search: 'Cian Ducrot', genre: 'Live Music', description: 'Cian Ducrot are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'neck-deep-glasgow', name: 'Neck Deep Glasgow', search: 'Neck Deep Glasgow', genre: 'Live Music', description: 'Neck Deep Glasgow are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lorde', name: 'Lorde', search: 'Lorde', genre: 'Live Music', description: 'Lorde are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'xavier-naidoo-cologne', name: 'Xavier Naidoo Cologne', search: 'Xavier Naidoo Cologne', genre: 'Live Music', description: 'Xavier Naidoo Cologne are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cian-ducrot-glasgow', name: 'Cian Ducrot Glasgow', search: 'Cian Ducrot Glasgow', genre: 'Live Music', description: 'Cian Ducrot Glasgow are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'neck-deep', name: 'Neck Deep', search: 'Neck Deep', genre: 'Live Music', description: 'Neck Deep are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'xavier-naidoo', name: 'Xavier Naidoo', search: 'Xavier Naidoo', genre: 'Live Music', description: 'Xavier Naidoo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-elite-wrestling-dynamite', name: 'All Elite Wrestling: Dynamite', search: 'All Elite Wrestling: Dynamite', genre: 'Sports', description: 'All Elite Wrestling: Dynamite are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'die-hamburger-goldkehlchen', name: 'Die Hamburger Goldkehlchen', search: 'Die Hamburger Goldkehlchen', genre: 'Live Music', description: 'Die Hamburger Goldkehlchen are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'professor-brian-cox', name: 'Professor Brian Cox', search: 'Professor Brian Cox', genre: 'Live Music', description: 'Professor Brian Cox are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cian-ducrot-leeds', name: 'Cian Ducrot Leeds', search: 'Cian Ducrot Leeds', genre: 'Live Music', description: 'Cian Ducrot Leeds are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'neck-deep-birmingham', name: 'Neck Deep Birmingham', search: 'Neck Deep Birmingham', genre: 'Live Music', description: 'Neck Deep Birmingham are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'doves', name: 'Doves', search: 'Doves', genre: 'Live Music', description: 'Doves are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'robert-plant-edinburgh', name: 'Robert Plant Edinburgh', search: 'Robert Plant Edinburgh', genre: 'Live Music', description: 'Robert Plant Edinburgh are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jonas-brothers', name: 'Jonas Brothers', search: 'Jonas Brothers', genre: 'Live Music', description: 'Jonas Brothers are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'peter-kay', name: 'Peter Kay', search: 'Peter Kay', genre: 'Live Music', description: 'Peter Kay are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gims-paris', name: 'GIMS Paris', search: 'GIMS Paris', genre: 'Live Music', description: 'GIMS Paris are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'arijit-singh-abu-dhabi', name: 'Arijit Singh Abu Dhabi', search: 'Arijit Singh Abu Dhabi', genre: 'Live Music', description: 'Arijit Singh Abu Dhabi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'neck-deep-london', name: 'Neck Deep London', search: 'Neck Deep London', genre: 'Live Music', description: 'Neck Deep London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'keith-kristyn-getty', name: 'Keith & Kristyn Getty', search: 'Keith & Kristyn Getty', genre: 'Live Music', description: 'Keith & Kristyn Getty are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tiesto', name: 'Tiesto', search: 'Tiesto', genre: 'Live Music', description: 'Tiesto are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'david-guetta', name: 'David Guetta', search: 'David Guetta', genre: 'Live Music', description: 'David Guetta are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bohse-onkelz', name: 'Bohse Onkelz', search: 'Bohse Onkelz', genre: 'Live Music', description: 'Bohse Onkelz are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'carols-at-the-royal-albert-hall', name: 'Carols at the Royal Albert Hall', search: 'Carols at the Royal Albert Hall', genre: 'Live Music', description: 'Carols at the Royal Albert Hall are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-fitipaldis-gijn', name: 'Fito & Fitipaldis Gijón', search: 'Fito & Fitipaldis Gijón', genre: 'Live Music', description: 'Fito & Fitipaldis Gijón are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gladiators-live-glasgow', name: 'Gladiators Live Glasgow', search: 'Gladiators Live Glasgow', genre: 'Sports', description: 'Gladiators Live Glasgow are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dom-dolla', name: 'Dom Dolla', search: 'Dom Dolla', genre: 'Live Music', description: 'Dom Dolla are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mora-lo-mismo-de-siempre', name: 'Mora - Lo Mismo de Siempre', search: 'Mora - Lo Mismo de Siempre', genre: 'Live Music', description: 'Mora - Lo Mismo de Siempre are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-round-two', name: 'World Darts Championship: Round Two', search: 'World Darts Championship: Round Two', genre: 'Sports', description: 'World Darts Championship: Round Two are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'doves-manchester', name: 'Doves Manchester', search: 'Doves Manchester', genre: 'Live Music', description: 'Doves Manchester are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-mary-wallopers-glasgow', name: 'The Mary Wallopers Glasgow', search: 'The Mary Wallopers Glasgow', genre: 'Live Music', description: 'The Mary Wallopers Glasgow are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gims', name: 'Gims', search: 'Gims', genre: 'Live Music', description: 'Gims are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'new-england-patriots-at-baltimore-ravens', name: 'New England Patriots at Baltimore Ravens', search: 'New England Patriots at Baltimore Ravens', genre: 'Sports', description: 'New England Patriots at Baltimore Ravens are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cincinnati-bengals-at-miami-dolphins', name: 'Cincinnati Bengals at Miami Dolphins (Sunday Night Football)', search: 'Cincinnati Bengals at Miami Dolphins (Sunday Night Football)', genre: 'Sports', description: 'Cincinnati Bengals at Miami Dolphins (Sunday Night Football) are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'pittsburgh-steelers-at-detroit-lions', name: 'Pittsburgh Steelers at Detroit Lions', search: 'Pittsburgh Steelers at Detroit Lions', genre: 'Sports', description: 'Pittsburgh Steelers at Detroit Lions are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tampa-bay-buccaneers-at-carolina-panthers', name: 'Tampa Bay Buccaneers at Carolina Panthers', search: 'Tampa Bay Buccaneers at Carolina Panthers', genre: 'Sports', description: 'Tampa Bay Buccaneers at Carolina Panthers are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'kansas-city-chiefs-at-tennessee-titans', name: 'Kansas City Chiefs at Tennessee Titans', search: 'Kansas City Chiefs at Tennessee Titans', genre: 'Sports', description: 'Kansas City Chiefs at Tennessee Titans are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'carols-at-the-hall', name: 'Carols at the Hall', search: 'Carols at the Hall', genre: 'Live Music', description: 'Carols at the Hall are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'san-francisco-49ers-at-indianapolis-colts', name: 'San Francisco 49ers at Indianapolis Colts (Monday Night Football)', search: 'San Francisco 49ers at Indianapolis Colts (Monday Night Football)', genre: 'Sports', description: 'San Francisco 49ers at Indianapolis Colts (Monday Night Football) are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'robert-plant-york', name: 'Robert Plant York', search: 'Robert Plant York', genre: 'Live Music', description: 'Robert Plant York are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'backstreet-boys', name: 'Backstreet Boys', search: 'Backstreet Boys', genre: 'Live Music', description: 'Backstreet Boys are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-round-three', name: 'World Darts Championship: Round Three', search: 'World Darts Championship: Round Three', genre: 'Sports', description: 'World Darts Championship: Round Three are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'picture-this', name: 'Picture This', search: 'Picture This', genre: 'Live Music', description: 'Picture This are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'shakira', name: 'Shakira', search: 'Shakira', genre: 'Live Music', description: 'Shakira are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'claudio-baglioni', name: 'Claudio Baglioni', search: 'Claudio Baglioni', genre: 'Live Music', description: 'Claudio Baglioni are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-fitipaldis-madrid', name: 'Fito & Fitipaldis Madrid', search: 'Fito & Fitipaldis Madrid', genre: 'Live Music', description: 'Fito & Fitipaldis Madrid are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-round-3-round-4', name: 'World Darts Championship: Round 3 & Round 4', search: 'World Darts Championship: Round 3 & Round 4', genre: 'Sports', description: 'World Darts Championship: Round 3 & Round 4 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jennifer-lopez', name: 'Jennifer Lopez', search: 'Jennifer Lopez', genre: 'Live Music', description: 'Jennifer Lopez are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-round-four', name: 'World Darts Championship: Round Four', search: 'World Darts Championship: Round Four', genre: 'Sports', description: 'World Darts Championship: Round Four are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'duran-duran', name: 'Duran Duran', search: 'Duran Duran', genre: 'Live Music', description: 'Duran Duran are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'matt-rife-boston', name: 'Matt Rife Boston', search: 'Matt Rife Boston', genre: 'Live Music', description: 'Matt Rife Boston are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'new-years-eve-gala-dinner-under-the-stars-maroon-5', name: 'New Year’s Eve Gala Dinner Under The Stars Maroon 5', search: 'New Year’s Eve Gala Dinner Under The Stars Maroon 5', genre: 'Live Music', description: 'New Year’s Eve Gala Dinner Under The Stars Maroon 5 are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mayor-of-londons-new-years-eve-fireworks', name: 'Mayor of London\'s New Year\'s Eve Fireworks', search: 'Mayor of London\'s New Year\'s Eve Fireworks', genre: 'Live Music', description: 'Mayor of London\'s New Year\'s Eve Fireworks are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nate-smith', name: 'Nate Smith', search: 'Nate Smith', genre: 'Live Music', description: 'Nate Smith are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'swedish-house-mafia', name: 'Swedish House Mafia', search: 'Swedish House Mafia', genre: 'Live Music', description: 'Swedish House Mafia are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-alicia-keys', name: 'Saadiyat Nights: Alicia Keys', search: 'Saadiyat Nights: Alicia Keys', genre: 'Live Music', description: 'Saadiyat Nights: Alicia Keys are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-quarter-finals', name: 'World Darts Championship: Quarter - Finals', search: 'World Darts Championship: Quarter - Finals', genre: 'Sports', description: 'World Darts Championship: Quarter - Finals are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-darts-championship-semi-finals', name: 'World Darts Championship: Semi - Finals', search: 'World Darts Championship: Semi - Finals', genre: 'Sports', description: 'World Darts Championship: Semi - Finals are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'morrissey', name: 'Morrissey', search: 'Morrissey', genre: 'Live Music', description: 'Morrissey are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'oscar-and-the-wolf', name: 'Oscar And The Wolf', search: 'Oscar And The Wolf', genre: 'Live Music', description: 'Oscar And The Wolf are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ocean-colour-scene-oxford', name: 'Ocean Colour Scene Oxford', search: 'Ocean Colour Scene Oxford', genre: 'Live Music', description: 'Ocean Colour Scene Oxford are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'wwe-live', name: 'WWE Live', search: 'WWE Live', genre: 'Sports', description: 'WWE Live are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-fitipaldis', name: 'Fito & Fitipaldis', search: 'Fito & Fitipaldis', genre: 'Live Music', description: 'Fito & Fitipaldis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ovo-by-cirque-du-soleil', name: 'OVO by Cirque du Soleil', search: 'OVO by Cirque du Soleil', genre: 'Live Music', description: 'OVO by Cirque du Soleil are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'riles', name: 'Riles', search: 'Riles', genre: 'Live Music', description: 'Riles are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'twice-vancouver', name: 'Twice Vancouver', search: 'Twice Vancouver', genre: 'Live Music', description: 'Twice Vancouver are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ocean-colour-scene-liverpool', name: 'Ocean Colour Scene Liverpool', search: 'Ocean Colour Scene Liverpool', genre: 'Live Music', description: 'Ocean Colour Scene Liverpool are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-diana-ross-seal', name: 'Saadiyat Nights: Diana Ross & Seal', search: 'Saadiyat Nights: Diana Ross & Seal', genre: 'Live Music', description: 'Saadiyat Nights: Diana Ross & Seal are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207-cologne', name: 'Apache 207 Cologne', search: 'Apache 207 Cologne', genre: 'Live Music', description: 'Apache 207 Cologne are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey', name: 'Halsey', search: 'Halsey', genre: 'Live Music', description: 'Halsey are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'when-gavin-met-stacey', name: 'When Gavin Met Stacey', search: 'When Gavin Met Stacey', genre: 'Live Music', description: 'When Gavin Met Stacey are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-ludovico-einaudi', name: 'Saadiyat Nights: Ludovico Einaudi', search: 'Saadiyat Nights: Ludovico Einaudi', genre: 'Live Music', description: 'Saadiyat Nights: Ludovico Einaudi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'yungblud', name: 'Yungblud', search: 'Yungblud', genre: 'Live Music', description: 'Yungblud are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'opm-legends-ely-buendia-and-chito-miranda', name: 'OPM Legends: Ely Buendia and Chito Miranda', search: 'OPM Legends: Ely Buendia and Chito Miranda', genre: 'Live Music', description: 'OPM Legends: Ely Buendia and Chito Miranda are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'david-tao', name: 'David Tao', search: 'David Tao', genre: 'Live Music', description: 'David Tao are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'shaggy-with-the-houston-symphony', name: 'Shaggy with the Houston Symphony (Rescheduled from 6/14/2025)', search: 'Shaggy with the Houston Symphony (Rescheduled from 6/14/2025)', genre: 'Live Music', description: 'Shaggy with the Houston Symphony (Rescheduled from 6/14/2025) are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mariah-the-scientist', name: 'Mariah the Scientist', search: 'Mariah the Scientist', genre: 'Live Music', description: 'Mariah the Scientist are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'twice-seattle', name: 'Twice Seattle', search: 'Twice Seattle', genre: 'Live Music', description: 'Twice Seattle are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'burna-boy-helsinki', name: 'Burna Boy Helsinki', search: 'Burna Boy Helsinki', genre: 'Live Music', description: 'Burna Boy Helsinki are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207', name: 'Apache 207', search: 'Apache 207', genre: 'Live Music', description: 'Apache 207 are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'david-byrne', name: 'David Byrne', search: 'David Byrne', genre: 'Live Music', description: 'David Byrne are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'architects', name: 'Architects', search: 'Architects', genre: 'Live Music', description: 'Architects are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'burna-boy', name: 'Burna Boy', search: 'Burna Boy', genre: 'Live Music', description: 'Burna Boy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'milo-j', name: 'Milo J', search: 'Milo J', genre: 'Live Music', description: 'Milo J are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'barry-manilow', name: 'Barry Manilow', search: 'Barry Manilow', genre: 'Live Music', description: 'Barry Manilow are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'p1harmony-amsterdam', name: 'P1Harmony Amsterdam', search: 'P1Harmony Amsterdam', genre: 'Live Music', description: 'P1Harmony Amsterdam are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-fitipaldis-barcelona', name: 'Fito & Fitipaldis Barcelona', search: 'Fito & Fitipaldis Barcelona', genre: 'Live Music', description: 'Fito & Fitipaldis Barcelona are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'slaughter-to-prevail-london', name: 'Slaughter to Prevail London', search: 'Slaughter to Prevail London', genre: 'Live Music', description: 'Slaughter to Prevail London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'orelsan', name: 'Orelsan', search: 'Orelsan', genre: 'Live Music', description: 'Orelsan are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'franky-rizardo', name: 'Franky Rizardo', search: 'Franky Rizardo', genre: 'Live Music', description: 'Franky Rizardo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tarkan-istanbul', name: 'TARKAN Istanbul', search: 'TARKAN Istanbul', genre: 'Live Music', description: 'TARKAN Istanbul are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fito-y-fitipaldis', name: 'Fito Y Fitipaldis', search: 'Fito Y Fitipaldis', genre: 'Live Music', description: 'Fito Y Fitipaldis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'slaughter-to-prevail', name: 'Slaughter To Prevail', search: 'Slaughter To Prevail', genre: 'Live Music', description: 'Slaughter To Prevail are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nick-cave-and-the-bad-seeds', name: 'Nick Cave and The Bad Seeds', search: 'Nick Cave and The Bad Seeds', genre: 'Live Music', description: 'Nick Cave and The Bad Seeds are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-lewis-capaldi', name: 'Saadiyat Nights: Lewis Capaldi', search: 'Saadiyat Nights: Lewis Capaldi', genre: 'Live Music', description: 'Saadiyat Nights: Lewis Capaldi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'burna-boy-copenhagen', name: 'Burna Boy Copenhagen', search: 'Burna Boy Copenhagen', genre: 'Live Music', description: 'Burna Boy Copenhagen are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cem-yilmaz-abu-dhabi', name: 'Cem Yilmaz Abu Dhabi', search: 'Cem Yilmaz Abu Dhabi', genre: 'Live Music', description: 'Cem Yilmaz Abu Dhabi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'yungblud-brisbane', name: 'Yungblud Brisbane', search: 'Yungblud Brisbane', genre: 'Live Music', description: 'Yungblud Brisbane are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cirque-du-soleil-kurios', name: 'Cirque Du Soleil - Kurios', search: 'Cirque Du Soleil - Kurios', genre: 'Live Music', description: 'Cirque Du Soleil - Kurios are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'xavier-naidoo-leipzig', name: 'Xavier Naidoo Leipzig', search: 'Xavier Naidoo Leipzig', genre: 'Live Music', description: 'Xavier Naidoo Leipzig are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'australian-open-single-session', name: 'Australian Open - Single Session (Day)', search: 'Australian Open - Single Session (Day)', genre: 'Sports', description: 'Australian Open - Single Session (Day) are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nba-london-game', name: 'NBA London Game', search: 'NBA London Game', genre: 'Sports', description: 'NBA London Game are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'p1harmony', name: 'P1Harmony', search: 'P1Harmony', genre: 'Live Music', description: 'P1Harmony are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cast', name: 'Cast', search: 'Cast', genre: 'Live Music', description: 'Cast are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207-hannover', name: 'Apache 207 Hannover', search: 'Apache 207 Hannover', genre: 'Live Music', description: 'Apache 207 Hannover are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-last-dinner-party', name: 'The Last Dinner Party', search: 'The Last Dinner Party', genre: 'Live Music', description: 'The Last Dinner Party are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'professor-brian-cox-dunstable', name: 'Professor Brian Cox Dunstable', search: 'Professor Brian Cox Dunstable', genre: 'Live Music', description: 'Professor Brian Cox Dunstable are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'hilary-duff', name: 'Hilary Duff', search: 'Hilary Duff', genre: 'Live Music', description: 'Hilary Duff are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'electric-callboy', name: 'Electric Callboy', search: 'Electric Callboy', genre: 'Live Music', description: 'Electric Callboy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dr-jordan-peterson', name: 'Dr. Jordan Peterson', search: 'Dr. Jordan Peterson', genre: 'Live Music', description: 'Dr. Jordan Peterson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-time-low', name: 'All Time Low', search: 'All Time Low', genre: 'Live Music', description: 'All Time Low are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'xavier-naidoo-berlin', name: 'Xavier Naidoo Berlin', search: 'Xavier Naidoo Berlin', genre: 'Live Music', description: 'Xavier Naidoo Berlin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'zayn', name: 'Zayn', search: 'Zayn', genre: 'Live Music', description: 'Zayn are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'john-mayer', name: 'John Mayer', search: 'John Mayer', genre: 'Live Music', description: 'John Mayer are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dean-lewis', name: 'Dean Lewis', search: 'Dean Lewis', genre: 'Live Music', description: 'Dean Lewis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'epica-amaranthe-glasgow', name: 'Epica & Amaranthe Glasgow', search: 'Epica & Amaranthe Glasgow', genre: 'Live Music', description: 'Epica & Amaranthe Glasgow are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'professor-brian-cox-stevenage', name: 'Professor Brian Cox Stevenage', search: 'Professor Brian Cox Stevenage', genre: 'Live Music', description: 'Professor Brian Cox Stevenage are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tom-odell', name: 'Tom Odell', search: 'Tom Odell', genre: 'Live Music', description: 'Tom Odell are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'an-evening-with-the-fast-show-london', name: 'An Evening with The Fast Show London', search: 'An Evening with The Fast Show London', genre: 'Live Music', description: 'An Evening with The Fast Show London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bushido-munich', name: 'Bushido Munich', search: 'Bushido Munich', genre: 'Live Music', description: 'Bushido Munich are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-time-low-cardiff', name: 'All Time Low Cardiff', search: 'All Time Low Cardiff', genre: 'Live Music', description: 'All Time Low Cardiff are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dijon', name: 'Dijon', search: 'Dijon', genre: 'Live Music', description: 'Dijon are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey-amsterdam', name: 'Halsey Amsterdam', search: 'Halsey Amsterdam', genre: 'Live Music', description: 'Halsey Amsterdam are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'raye', name: 'Raye', search: 'Raye', genre: 'Live Music', description: 'Raye are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'guano-apes', name: 'Guano Apes', search: 'Guano Apes', genre: 'Live Music', description: 'Guano Apes are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'epica-amaranthe-manchester', name: 'Epica & Amaranthe Manchester', search: 'Epica & Amaranthe Manchester', genre: 'Live Music', description: 'Epica & Amaranthe Manchester are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-time-low-manchester', name: 'All Time Low Manchester', search: 'All Time Low Manchester', genre: 'Live Music', description: 'All Time Low Manchester are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'xavier-naidoo-mannheim', name: 'Xavier Naidoo Mannheim', search: 'Xavier Naidoo Mannheim', genre: 'Live Music', description: 'Xavier Naidoo Mannheim are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jerry-seinfeld', name: 'Jerry Seinfeld', search: 'Jerry Seinfeld', genre: 'Live Music', description: 'Jerry Seinfeld are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey-berlin', name: 'Halsey Berlin', search: 'Halsey Berlin', genre: 'Live Music', description: 'Halsey Berlin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'eagles', name: 'Eagles', search: 'Eagles', genre: 'Live Music', description: 'Eagles are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'strictly-come-dancing-live-tour-2026-birmingham', name: 'Strictly Come Dancing Live Tour 2026 Birmingham', search: 'Strictly Come Dancing Live Tour 2026 Birmingham', genre: 'Live Music', description: 'Strictly Come Dancing Live Tour 2026 Birmingham are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ar-rahman', name: 'A.R. Rahman', search: 'A.R. Rahman', genre: 'Live Music', description: 'A.R. Rahman are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'levity', name: 'Levity', search: 'Levity', genre: 'Live Music', description: 'Levity are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'epica-amaranthe-london', name: 'Epica & Amaranthe London', search: 'Epica & Amaranthe London', genre: 'Live Music', description: 'Epica & Amaranthe London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'josh-johnson', name: 'Josh Johnson', search: 'Josh Johnson', genre: 'Live Music', description: 'Josh Johnson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey-dsseldorf', name: 'Halsey Düsseldorf', search: 'Halsey Düsseldorf', genre: 'Live Music', description: 'Halsey Düsseldorf are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'renato-zero', name: 'Renato Zero', search: 'Renato Zero', genre: 'Live Music', description: 'Renato Zero are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'strictly-come-dancing', name: 'Strictly Come Dancing', search: 'Strictly Come Dancing', genre: 'Live Music', description: 'Strictly Come Dancing are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-john-mayer', name: 'Saadiyat Nights: John Mayer', search: 'Saadiyat Nights: John Mayer', genre: 'Live Music', description: 'Saadiyat Nights: John Mayer are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'russell-howard', name: 'Russell Howard', search: 'Russell Howard', genre: 'Live Music', description: 'Russell Howard are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207-zrich', name: 'Apache 207 Zürich', search: 'Apache 207 Zürich', genre: 'Live Music', description: 'Apache 207 Zürich are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'epica-amaranthe', name: 'Epica & Amaranthe', search: 'Epica & Amaranthe', genre: 'Live Music', description: 'Epica & Amaranthe are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'white-lies', name: 'White Lies', search: 'White Lies', genre: 'Live Music', description: 'White Lies are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lorna-shore', name: 'Lorna Shore', search: 'Lorna Shore', genre: 'Live Music', description: 'Lorna Shore are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cmat', name: 'CMAT', search: 'CMAT', genre: 'Live Music', description: 'CMAT are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'orelsan-limoges', name: 'Orelsan Limoges', search: 'Orelsan Limoges', genre: 'Live Music', description: 'Orelsan Limoges are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nate-bargatze', name: 'Nate Bargatze', search: 'Nate Bargatze', genre: 'Live Music', description: 'Nate Bargatze are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'p1harmony-berlin', name: 'P1Harmony Berlin', search: 'P1Harmony Berlin', genre: 'Live Music', description: 'P1Harmony Berlin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dita-von-teese', name: 'Dita Von Teese', search: 'Dita Von Teese', genre: 'Live Music', description: 'Dita Von Teese are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey-paris', name: 'Halsey Paris', search: 'Halsey Paris', genre: 'Live Music', description: 'Halsey Paris are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'andre-rieu', name: 'Andre Rieu', search: 'Andre Rieu', genre: 'Live Music', description: 'Andre Rieu are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jinger', name: 'Jinger', search: 'Jinger', genre: 'Live Music', description: 'Jinger are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'chris-norman', name: 'Chris Norman', search: 'Chris Norman', genre: 'Live Music', description: 'Chris Norman are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'prima-facie', name: 'Prima Facie', search: 'Prima Facie', genre: 'Live Music', description: 'Prima Facie are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'an-evening-with-the-fast-show', name: 'An Evening with The Fast Show', search: 'An Evening with The Fast Show', genre: 'Live Music', description: 'An Evening with The Fast Show are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apache-207-berlin', name: 'Apache 207 Berlin', search: 'Apache 207 Berlin', genre: 'Live Music', description: 'Apache 207 Berlin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'professor-brian-cox-leicester', name: 'Professor Brian Cox Leicester', search: 'Professor Brian Cox Leicester', genre: 'Live Music', description: 'Professor Brian Cox Leicester are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mo-gilligan', name: 'Mo Gilligan', search: 'Mo Gilligan', genre: 'Live Music', description: 'Mo Gilligan are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ghost', name: 'Ghost', search: 'Ghost', genre: 'Live Music', description: 'Ghost are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'louis-ck-london', name: 'Louis C.K. London', search: 'Louis C.K. London', genre: 'Live Music', description: 'Louis C.K. London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-derulo-glasgow', name: 'Jason Derulo Glasgow', search: 'Jason Derulo Glasgow', genre: 'Live Music', description: 'Jason Derulo Glasgow are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jinjer-manchester', name: 'Jinjer Manchester', search: 'Jinjer Manchester', genre: 'Live Music', description: 'Jinjer Manchester are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey-manchester', name: 'Halsey Manchester', search: 'Halsey Manchester', genre: 'Live Music', description: 'Halsey Manchester are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'orelsan-strasbourg', name: 'Orelsan Strasbourg', search: 'Orelsan Strasbourg', genre: 'Live Music', description: 'Orelsan Strasbourg are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-max-richter', name: 'Saadiyat Nights: Max Richter', search: 'Saadiyat Nights: Max Richter', genre: 'Live Music', description: 'Saadiyat Nights: Max Richter are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'louis-ck', name: 'Louis C.K. (18+)', search: 'Louis C.K. (18+)', genre: 'Live Music', description: 'Louis C.K. (18+) are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dr-jordan-b-peterson-porto', name: 'Dr. Jordan B. Peterson Porto', search: 'Dr. Jordan B. Peterson Porto', genre: 'Live Music', description: 'Dr. Jordan B. Peterson Porto are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-derulo-birmingham', name: 'Jason Derulo Birmingham', search: 'Jason Derulo Birmingham', genre: 'Live Music', description: 'Jason Derulo Birmingham are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jinjer', name: 'Jinjer', search: 'Jinjer', genre: 'Live Music', description: 'Jinjer are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'deftones', name: 'Deftones', search: 'Deftones', genre: 'Live Music', description: 'Deftones are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'suede-folkestone', name: 'Suede Folkestone', search: 'Suede Folkestone', genre: 'Live Music', description: 'Suede Folkestone are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'strictly-come-dancing-live-tour-2026-leeds', name: 'Strictly Come Dancing Live Tour 2026 Leeds', search: 'Strictly Come Dancing Live Tour 2026 Leeds', genre: 'Live Music', description: 'Strictly Come Dancing Live Tour 2026 Leeds are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'miles-kane', name: 'Miles Kane', search: 'Miles Kane', genre: 'Live Music', description: 'Miles Kane are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'indochine-amneville', name: 'Indochine Amneville', search: 'Indochine Amneville', genre: 'Live Music', description: 'Indochine Amneville are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  const normSlug = slug.toLowerCase();
  let artist = ARTISTS.find(a => a.slug === normSlug);

  // If not in the hardcoded list, check KV for auto-discovered artist data
  if (!artist) {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      try {
        const kvData = await kv.get(`concert:artist:${normSlug}`);
        if (kvData) {
          artist = JSON.parse(kvData);
        }
      } catch {}
    }
  }

  // Fallback — check Awin events for any unknown slug
  if (!artist) {
    const name = normSlug.replace(/-/g, ' ');
    try {
      const origin  = new URL(request.url).origin;
      const awinUrl = `${origin}/api/awin-events?name=${encodeURIComponent(name)}&size=1`;
      const awinResp = await fetch(awinUrl);
      if (awinResp.ok) {
        const awinData = await awinResp.json();
        if (awinData.events && awinData.events.length > 0) {
          const ev          = awinData.events[0];
          const displayName = toTitleCase(name);
          const rawDesc     = (ev.description || '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim();
          artist = {
            slug:        normSlug,
            name:        displayName,
            search:      displayName,
            genre:       ev.category || 'Live Events',
            description: rawDesc.slice(0, 300) || `Compare ${displayName} ticket prices across verified sellers.`
          };
        }
      }
    } catch {}

    // Slug-based fallback — synthesise from slug for any slug value.
    // If a request reaches /api/concert?slug=X it means concert/X.html exists as a
    // deployed stub page. A 404 here is never correct — the page would break.
    // TM attraction lookup below will find an image if one exists; if not, the page
    // still renders correctly with a gradient placeholder.
    if (!artist) {
      const displayName = toTitleCase(normSlug.replace(/-/g, ' '));
      artist = {
        slug:        normSlug,
        name:        displayName,
        search:      displayName,
        genre:       'Live Music',
        description: 'Compare ' + displayName + ' ticket prices across verified sellers on TicketScout.'
      };
    }
  }

  // Resolve Ticketmaster attraction ID for this artist
  const apiKey = env.TM_API_KEY;
  let attractionId = null;
  let tmImage = null;

  if (apiKey) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('keyword', artist.search);
      tmUrl.searchParams.set('size', '10');

      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      const attractions = tmData?._embedded?.attractions || [];

      if (attractions.length > 0) {
        const TRIBUTE_KEYWORDS = ['tribute', 'salute', 'legacy', 'experience', 'revival',
          'forever', 'reunion', 'story of', 'performed by', 'feat.', 'vs.', ' vs '];

        const normSearch = artist.search.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

        const scored = attractions.map(a => {
          const normName = (a.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          let score = 0;
          if (normName === normSearch)             score = 100;
          else if (normName.startsWith(normSearch)) score = 50;
          else if (normName.includes(normSearch))   score = 20;

          const isTribute = TRIBUTE_KEYWORDS.some(kw => a.name.toLowerCase().includes(kw));
          if (isTribute) score -= 60;

          return { attraction: a, score };
        }).sort((a, b) => b.score - a.score);

        const best = scored[0].attraction;
        attractionId = best.id;
        const images = best.images || [];
        const sixteenNine = images
          .filter(img => img.ratio === '16_9' && img.width > 500)
          .sort((a, b) => (b.width || 0) - (a.width || 0));
        tmImage = sixteenNine[0]?.url || images.find(img => img.width > 500)?.url || images[0]?.url || null;
      }
    } catch (err) {
      console.error('TM attraction lookup error:', err);
    }
  }

  return jsonResponse({
    artist: {
      slug:        artist.slug,
      name:        artist.name,
      genre:       artist.genre,
      description: artist.description
    },
    attractionId,
    tmImage
  }, 200);
}

function toTitleCase(str) {
  return (str || '').replace(/\b\w/g, c => c.toUpperCase());
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}