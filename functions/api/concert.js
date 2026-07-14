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
  { slug: 'dara-o-briain', name: 'Dara O Briain', search: 'Dara O Briain', genre: 'Live Music', description: 'Dara O Briain are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-derulo-london', name: 'Jason Derulo London', search: 'Jason Derulo London', genre: 'Live Music', description: 'Jason Derulo London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jinjer-london', name: 'Jinjer London', search: 'Jinjer London', genre: 'Live Music', description: 'Jinjer London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-time-low-hamburg', name: 'All Time Low Hamburg', search: 'All Time Low Hamburg', genre: 'Live Music', description: 'All Time Low Hamburg are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gregory-alan-isakov', name: 'Gregory Alan Isakov', search: 'Gregory Alan Isakov', genre: 'Live Music', description: 'Gregory Alan Isakov are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'suede-portsmouth', name: 'Suede Portsmouth', search: 'Suede Portsmouth', genre: 'Live Music', description: 'Suede Portsmouth are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'earl-sweatshirt', name: 'Earl Sweatshirt', search: 'Earl Sweatshirt', genre: 'Live Music', description: 'Earl Sweatshirt are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-ricky-martin', name: 'Saadiyat Nights: Ricky Martin', search: 'Saadiyat Nights: Ricky Martin', genre: 'Live Music', description: 'Saadiyat Nights: Ricky Martin are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'andy-c-london', name: 'Andy C London', search: 'Andy C London', genre: 'Live Music', description: 'Andy C London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'deftones-hamburg', name: 'Deftones Hamburg', search: 'Deftones Hamburg', genre: 'Live Music', description: 'Deftones Hamburg are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'halsey-london', name: 'Halsey London', search: 'Halsey London', genre: 'Live Music', description: 'Halsey London are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lucio-corsi', name: 'Lucio Corsi', search: 'Lucio Corsi', genre: 'Live Music', description: 'Lucio Corsi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'coupe-de-france-de-hockey', name: 'Coupe de France de Hockey', search: 'Coupe de France de Hockey', genre: 'Sports', description: 'Coupe de France de Hockey are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-damned', name: 'The Damned', search: 'The Damned', genre: 'Live Music', description: 'The Damned are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-derulo-cardiff', name: 'Jason Derulo Cardiff', search: 'Jason Derulo Cardiff', genre: 'Live Music', description: 'Jason Derulo Cardiff are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'new-wave-in-concert', name: 'New Wave in Concert', search: 'New Wave in Concert', genre: 'Live Music', description: 'New Wave in Concert are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'suede-bristol', name: 'Suede Bristol', search: 'Suede Bristol', genre: 'Live Music', description: 'Suede Bristol are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'miles-kane-bristol', name: 'Miles Kane Bristol', search: 'Miles Kane Bristol', genre: 'Live Music', description: 'Miles Kane Bristol are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-derulo-brighton', name: 'Jason Derulo Brighton', search: 'Jason Derulo Brighton', genre: 'Live Music', description: 'Jason Derulo Brighton are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'all-time-low-oslo', name: 'All Time Low Oslo', search: 'All Time Low Oslo', genre: 'Live Music', description: 'All Time Low Oslo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'artemas', name: 'Artemas', search: 'Artemas', genre: 'Live Music', description: 'Artemas are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'miles-kane-newcastle-upon-tyne', name: 'Miles Kane Newcastle upon Tyne', search: 'Miles Kane Newcastle upon Tyne', genre: 'Live Music', description: 'Miles Kane Newcastle upon Tyne are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'onerepublic', name: 'OneRepublic', search: 'OneRepublic', genre: 'Live Music', description: 'OneRepublic are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ashnikko', name: 'Ashnikko', search: 'Ashnikko', genre: 'Live Music', description: 'Ashnikko are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'chris-stapleton', name: 'Chris Stapleton', search: 'Chris Stapleton', genre: 'Live Music', description: 'Chris Stapleton are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'robbie-williams', name: 'Robbie Williams', search: 'Robbie Williams', genre: 'Live Music', description: 'Robbie Williams are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'alban-skenderaj', name: 'Alban Skenderaj', search: 'Alban Skenderaj', genre: 'Live Music', description: 'Alban Skenderaj are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'danny-ocean', name: 'Danny Ocean', search: 'Danny Ocean', genre: 'Live Music', description: 'Danny Ocean are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'motionless-in-white', name: 'Motionless in White', search: 'Motionless in White', genre: 'Live Music', description: 'Motionless in White are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-derulo', name: 'Jason Derulo', search: 'Jason Derulo', genre: 'Live Music', description: 'Jason Derulo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-kooks', name: 'The Kooks', search: 'The Kooks', genre: 'Live Music', description: 'The Kooks are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'underworld', name: 'Underworld', search: 'Underworld', genre: 'Live Music', description: 'Underworld are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'premier-league-darts', name: 'Premier League Darts', search: 'Premier League Darts', genre: 'Sports', description: 'Premier League Darts are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cirque-du-soleil-alegria', name: 'Cirque Du Soleil - Alegria', search: 'Cirque Du Soleil - Alegria', genre: 'Live Music', description: 'Cirque Du Soleil - Alegria are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'professor-brian-cox-warm-up', name: 'Professor Brian Cox - Warm Up', search: 'Professor Brian Cox - Warm Up', genre: 'Live Music', description: 'Professor Brian Cox - Warm Up are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nashville', name: 'Nashville', search: 'Nashville', genre: 'Live Music', description: 'Nashville are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'adrian-smith-richie-kotzen', name: 'Adrian Smith & Richie Kotzen', search: 'Adrian Smith & Richie Kotzen', genre: 'Live Music', description: 'Adrian Smith & Richie Kotzen are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'alter-bridge', name: 'Alter Bridge', search: 'Alter Bridge', genre: 'Live Music', description: 'Alter Bridge are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'intel-extreme-masters-3-day-pass', name: 'Intel Extreme Masters: 3 Day Pass', search: 'Intel Extreme Masters: 3 Day Pass', genre: 'Sports', description: 'Intel Extreme Masters: 3 Day Pass are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'intel-extreme-masters-friday', name: 'Intel Extreme Masters: Friday', search: 'Intel Extreme Masters: Friday', genre: 'Sports', description: 'Intel Extreme Masters: Friday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'fatboy-slim', name: 'Fatboy Slim', search: 'Fatboy Slim', genre: 'Live Music', description: 'Fatboy Slim are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'florence-and-the-machine', name: 'Florence and the Machine', search: 'Florence and the Machine', genre: 'Live Music', description: 'Florence and the Machine are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'christopher', name: 'Christopher', search: 'Christopher', genre: 'Live Music', description: 'Christopher are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'solomon', name: 'Solomon', search: 'Solomon', genre: 'Live Music', description: 'Solomon are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'charlotte-de-witte', name: 'Charlotte de Witte', search: 'Charlotte de Witte', genre: 'Live Music', description: 'Charlotte de Witte are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'trevor-noah', name: 'Trevor Noah', search: 'Trevor Noah', genre: 'Live Music', description: 'Trevor Noah are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'apashe', name: 'Apashe', search: 'Apashe', genre: 'Live Music', description: 'Apashe are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-opening-ceremony-ocer01', name: 'Winter Games: Opening Ceremony - OCER01', search: 'Winter Games: Opening Ceremony - OCER01', genre: 'Sports', description: 'Winter Games: Opening Ceremony - OCER01 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'elkie-brooks', name: 'Elkie Brooks', search: 'Elkie Brooks', genre: 'Live Music', description: 'Elkie Brooks are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'intel-extreme-masters-saturday', name: 'Intel Extreme Masters: Saturday', search: 'Intel Extreme Masters: Saturday', genre: 'Sports', description: 'Intel Extreme Masters: Saturday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-md-round-robin-ocur09', name: 'Winter Games: MD Round Robin - OCUR09', search: 'Winter Games: MD Round Robin - OCUR09', genre: 'Sports', description: 'Winter Games: MD Round Robin - OCUR09 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-big-air-final-osbd02', name: 'Winter Games: M Big Air Final - OSBD02', search: 'Winter Games: M Big Air Final - OSBD02', genre: 'Sports', description: 'Winter Games: M Big Air Final - OSBD02 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-mariah-carey', name: 'Saadiyat Nights: Mariah Carey', search: 'Saadiyat Nights: Mariah Carey', genre: 'Live Music', description: 'Saadiyat Nights: Mariah Carey are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'intel-extreme-masters-sunday', name: 'Intel Extreme Masters: Sunday', search: 'Intel Extreme Masters: Sunday', genre: 'Sports', description: 'Intel Extreme Masters: Sunday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'chris-ramsey', name: 'Chris Ramsey', search: 'Chris Ramsey', genre: 'Live Music', description: 'Chris Ramsey are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sombr', name: 'sombr', search: 'sombr', genre: 'Live Music', description: 'sombr are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-4', name: 'ABN AMRO Open - Session 4', search: 'ABN AMRO Open - Session 4', genre: 'Sports', description: 'ABN AMRO Open - Session 4 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jade', name: 'Jade', search: 'Jade', genre: 'Live Music', description: 'Jade are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mika', name: 'Mika', search: 'Mika', genre: 'Live Music', description: 'Mika are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-5', name: 'ABN AMRO Open - Session 5', search: 'ABN AMRO Open - Session 5', genre: 'Sports', description: 'ABN AMRO Open - Session 5 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saadiyat-nights-bryan-adams', name: 'Saadiyat Nights: Bryan Adams', search: 'Saadiyat Nights: Bryan Adams', genre: 'Live Music', description: 'Saadiyat Nights: Bryan Adams are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-preliminary-round-oiho22', name: 'Winter Games: M Preliminary Round - OIHO22', search: 'Winter Games: M Preliminary Round - OIHO22', genre: 'Sports', description: 'Winter Games: M Preliminary Round - OIHO22 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'eros-ramazzotti', name: 'Eros Ramazzotti', search: 'Eros Ramazzotti', genre: 'Live Music', description: 'Eros Ramazzotti are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jethro-tull', name: 'Jethro Tull', search: 'Jethro Tull', genre: 'Live Music', description: 'Jethro Tull are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'stardew-valley-symphony-of-seasons', name: 'Stardew Valley: Symphony Of Seasons', search: 'Stardew Valley: Symphony Of Seasons', genre: 'Live Music', description: 'Stardew Valley: Symphony Of Seasons are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-7', name: 'ABN AMRO Open - Session 7', search: 'ABN AMRO Open - Session 7', genre: 'Sports', description: 'ABN AMRO Open - Session 7 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-8', name: 'ABN AMRO Open - Session 8', search: 'ABN AMRO Open - Session 8', genre: 'Sports', description: 'ABN AMRO Open - Session 8 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'of-monsters-and-men', name: 'Of Monsters and Men', search: 'Of Monsters and Men', genre: 'Live Music', description: 'Of Monsters and Men are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'joost-klein', name: 'Joost Klein', search: 'Joost Klein', genre: 'Live Music', description: 'Joost Klein are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'indochine', name: 'Indochine', search: 'Indochine', genre: 'Live Music', description: 'Indochine are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-9', name: 'ABN AMRO Open - Session 9', search: 'ABN AMRO Open - Session 9', genre: 'Sports', description: 'ABN AMRO Open - Session 9 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-10', name: 'ABN AMRO Open - Session 10', search: 'ABN AMRO Open - Session 10', genre: 'Sports', description: 'ABN AMRO Open - Session 10 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-11', name: 'ABN AMRO Open - Session 11', search: 'ABN AMRO Open - Session 11', genre: 'Sports', description: 'ABN AMRO Open - Session 11 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-session-12', name: 'ABN AMRO Open - Session 12', search: 'ABN AMRO Open - Session 12', genre: 'Sports', description: 'ABN AMRO Open - Session 12 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nathy-peluso', name: 'Nathy Peluso', search: 'Nathy Peluso', genre: 'Live Music', description: 'Nathy Peluso are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-round-robin-ocur25', name: 'Winter Games: M Round Robin - OCUR25', search: 'Winter Games: M Round Robin - OCUR25', genre: 'Sports', description: 'Winter Games: M Round Robin - OCUR25 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-preliminary-round-oiho35', name: 'Winter Games: M Preliminary Round - OIHO35', search: 'Winter Games: M Preliminary Round - OIHO35', genre: 'Sports', description: 'Winter Games: M Preliminary Round - OIHO35 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'abn-amro-open-final', name: 'ABN AMRO Open - Final', search: 'ABN AMRO Open - Final', genre: 'Sports', description: 'ABN AMRO Open - Final are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-round-robin-ocur29', name: 'Winter Games: M Round Robin - OCUR29', search: 'Winter Games: M Round Robin - OCUR29', genre: 'Sports', description: 'Winter Games: M Round Robin - OCUR29 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-preliminary-round-oiho39', name: 'Winter Games: M Preliminary Round - OIHO39', search: 'Winter Games: M Preliminary Round - OIHO39', genre: 'Sports', description: 'Winter Games: M Preliminary Round - OIHO39 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-streets', name: 'The Streets', search: 'The Streets', genre: 'Live Music', description: 'The Streets are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'megadeth', name: 'Megadeth', search: 'Megadeth', genre: 'Live Music', description: 'Megadeth are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-aces', name: 'The Aces', search: 'The Aces', genre: 'Live Music', description: 'The Aces are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-qualification-playoffs-oiho47', name: 'Winter Games: M Qualification Playoffs - OIHO47', search: 'Winter Games: M Qualification Playoffs - OIHO47', genre: 'Sports', description: 'Winter Games: M Qualification Playoffs - OIHO47 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sean-paul', name: 'Sean Paul', search: 'Sean Paul', genre: 'Live Music', description: 'Sean Paul are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'avatar', name: 'Avatar', search: 'Avatar', genre: 'Live Music', description: 'Avatar are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'laufey', name: 'Laufey', search: 'Laufey', genre: 'Live Music', description: 'Laufey are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'twice', name: 'Twice', search: 'Twice', genre: 'Live Music', description: 'Twice are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-quarterfinals-oiho50', name: 'Winter Games: M Quarterfinals - OIHO50', search: 'Winter Games: M Quarterfinals - OIHO50', genre: 'Sports', description: 'Winter Games: M Quarterfinals - OIHO50 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'powerwolf', name: 'Powerwolf', search: 'Powerwolf', genre: 'Live Music', description: 'Powerwolf are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lainey-wilson', name: 'Lainey Wilson', search: 'Lainey Wilson', genre: 'Live Music', description: 'Lainey Wilson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-aldean', name: 'Jason Aldean', search: 'Jason Aldean', genre: 'Live Music', description: 'Jason Aldean are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-w-free-skating-ofsk11', name: 'Winter Games: W Free Skating - OFSK11', search: 'Winter Games: W Free Skating - OFSK11', genre: 'Sports', description: 'Winter Games: W Free Skating - OFSK11 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'antoon', name: 'Antoon', search: 'Antoon', genre: 'Live Music', description: 'Antoon are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'belle-and-sebastian', name: 'Belle and Sebastian', search: 'Belle and Sebastian', genre: 'Live Music', description: 'Belle and Sebastian are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jordan-davis', name: 'Jordan Davis', search: 'Jordan Davis', genre: 'Live Music', description: 'Jordan Davis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'billy-strings', name: 'Billy Strings', search: 'Billy Strings', genre: 'Live Music', description: 'Billy Strings are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-semifinals-oiho55', name: 'Winter Games: M Semifinals - OIHO55', search: 'Winter Games: M Semifinals - OIHO55', genre: 'Sports', description: 'Winter Games: M Semifinals - OIHO55 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-semifinals-oiho56', name: 'Winter Games: M Semifinals - OIHO56', search: 'Winter Games: M Semifinals - OIHO56', genre: 'Sports', description: 'Winter Games: M Semifinals - OIHO56 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mana', name: 'Mana', search: 'Mana', genre: 'Live Music', description: 'Mana are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'zach-top', name: 'Zach Top', search: 'Zach Top', genre: 'Live Music', description: 'Zach Top are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-exhibition-gala-ofsk12', name: 'Winter Games: Exhibition Gala - OFSK12', search: 'Winter Games: Exhibition Gala - OFSK12', genre: 'Sports', description: 'Winter Games: Exhibition Gala - OFSK12 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'kali-uchis', name: 'Kali Uchis', search: 'Kali Uchis', genre: 'Live Music', description: 'Kali Uchis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-bronze-medal-oiho57', name: 'Winter Games: M Bronze Medal - OIHO57', search: 'Winter Games: M Bronze Medal - OIHO57', genre: 'Sports', description: 'Winter Games: M Bronze Medal - OIHO57 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'miguel', name: 'Miguel', search: 'Miguel', genre: 'Live Music', description: 'Miguel are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'hoyofair', name: 'HoYoFair', search: 'HoYoFair', genre: 'Live Music', description: 'HoYoFair are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'winter-games-m-gold-medal-oiho58', name: 'Winter Games: M Gold Medal - OIHO58', search: 'Winter Games: M Gold Medal - OIHO58', genre: 'Sports', description: 'Winter Games: M Gold Medal - OIHO58 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'players-championship', name: 'Players Championship', search: 'Players Championship', genre: 'Sports', description: 'Players Championship are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dubai-duty-free-tennis-championships-mens-day-1', name: 'Dubai Duty Free Tennis Championships Men\'s: Day 1', search: 'Dubai Duty Free Tennis Championships Men\'s: Day 1', genre: 'Sports', description: 'Dubai Duty Free Tennis Championships Men\'s: Day 1 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jack-savoretti', name: 'Jack Savoretti', search: 'Jack Savoretti', genre: 'Live Music', description: 'Jack Savoretti are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-band-camino', name: 'The Band Camino', search: 'The Band Camino', genre: 'Live Music', description: 'The Band Camino are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dubai-duty-free-tennis-championships-mens-day-2', name: 'Dubai Duty Free Tennis Championships Men\'s: Day 2', search: 'Dubai Duty Free Tennis Championships Men\'s: Day 2', genre: 'Sports', description: 'Dubai Duty Free Tennis Championships Men\'s: Day 2 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'acdc', name: 'AC/DC', search: 'AC/DC', genre: 'Live Music', description: 'AC/DC are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'franz-ferdinand', name: 'Franz Ferdinand', search: 'Franz Ferdinand', genre: 'Live Music', description: 'Franz Ferdinand are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dubai-duty-free-tennis-championships-mens-day-3', name: 'Dubai Duty Free Tennis Championships Men\'s: Day 3', search: 'Dubai Duty Free Tennis Championships Men\'s: Day 3', genre: 'Sports', description: 'Dubai Duty Free Tennis Championships Men\'s: Day 3 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'notre-dame-de-paris', name: 'Notre Dame de Paris', search: 'Notre Dame de Paris', genre: 'Live Music', description: 'Notre Dame de Paris are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dubai-duty-free-tennis-championships-mens-quarter-finals', name: 'Dubai Duty Free Tennis Championships Men\'s Quarter-Finals', search: 'Dubai Duty Free Tennis Championships Men\'s Quarter-Finals', genre: 'Sports', description: 'Dubai Duty Free Tennis Championships Men\'s Quarter-Finals are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'hans-zimmer', name: 'Hans Zimmer', search: 'Hans Zimmer', genre: 'Live Music', description: 'Hans Zimmer are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'duman', name: 'Duman', search: 'Duman', genre: 'Live Music', description: 'Duman are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'styx', name: 'Styx', search: 'Styx', genre: 'Live Music', description: 'Styx are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'audrey-hobert', name: 'Audrey Hobert', search: 'Audrey Hobert', genre: 'Live Music', description: 'Audrey Hobert are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dubai-duty-free-tennis-championships-mens-semi-finals', name: 'Dubai Duty Free Tennis Championships Men\'s Semi-Finals', search: 'Dubai Duty Free Tennis Championships Men\'s Semi-Finals', genre: 'Sports', description: 'Dubai Duty Free Tennis Championships Men\'s Semi-Finals are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'hakan-hellstrom', name: 'Hakan Hellstrom', search: 'Hakan Hellstrom', genre: 'Live Music', description: 'Hakan Hellstrom are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jeff-dunham', name: 'Jeff Dunham', search: 'Jeff Dunham', genre: 'Live Music', description: 'Jeff Dunham are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'dubai-duty-free-tennis-championships-mens-finals', name: 'Dubai Duty Free Tennis Championships Men\'s Finals', search: 'Dubai Duty Free Tennis Championships Men\'s Finals', genre: 'Sports', description: 'Dubai Duty Free Tennis Championships Men\'s Finals are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'monolink', name: 'Monolink', search: 'Monolink', genre: 'Live Music', description: 'Monolink are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'pawsa', name: 'Pawsa', search: 'Pawsa', genre: 'Live Music', description: 'Pawsa are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-vaccines', name: 'The Vaccines', search: 'The Vaccines', genre: 'Live Music', description: 'The Vaccines are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'zara-larsson', name: 'Zara Larsson', search: 'Zara Larsson', genre: 'Live Music', description: 'Zara Larsson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'harlem-globetrotters', name: 'Harlem Globetrotters', search: 'Harlem Globetrotters', genre: 'Live Music', description: 'Harlem Globetrotters are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'wu-tang-clan', name: 'Wu-Tang Clan', search: 'Wu-Tang Clan', genre: 'Live Music', description: 'Wu-Tang Clan are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lily-allen', name: 'Lily Allen', search: 'Lily Allen', genre: 'Live Music', description: 'Lily Allen are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'scouting-for-girls', name: 'Scouting for Girls', search: 'Scouting for Girls', genre: 'Live Music', description: 'Scouting for Girls are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tyler-childers', name: 'Tyler Childers', search: 'Tyler Childers', genre: 'Live Music', description: 'Tyler Childers are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sigrid', name: 'Sigrid', search: 'Sigrid', genre: 'Live Music', description: 'Sigrid are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'willow-avalon', name: 'Willow Avalon', search: 'Willow Avalon', genre: 'Live Music', description: 'Willow Avalon are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'achille-lauro', name: 'Achille Lauro', search: 'Achille Lauro', genre: 'Live Music', description: 'Achille Lauro are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'kesha', name: 'Kesha', search: 'Kesha', genre: 'Live Music', description: 'Kesha are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'poppy', name: 'Poppy', search: 'Poppy', genre: 'Live Music', description: 'Poppy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'danny-brown', name: 'Danny Brown', search: 'Danny Brown', genre: 'Live Music', description: 'Danny Brown are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'florent-pagny', name: 'Florent Pagny', search: 'Florent Pagny', genre: 'Live Music', description: 'Florent Pagny are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'greg-davies', name: 'Greg Davies', search: 'Greg Davies', genre: 'Live Music', description: 'Greg Davies are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sleaford-mods', name: 'Sleaford Mods', search: 'Sleaford Mods', genre: 'Live Music', description: 'Sleaford Mods are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'umberto-tozzi', name: 'Umberto Tozzi', search: 'Umberto Tozzi', genre: 'Live Music', description: 'Umberto Tozzi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gipsy-kings-featuring-nicolas-reyes', name: 'Gipsy Kings featuring Nicolas Reyes', search: 'Gipsy Kings featuring Nicolas Reyes', genre: 'Live Music', description: 'Gipsy Kings featuring Nicolas Reyes are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-world-of-hans-zimmer-the-immersive-symphony', name: 'The World Of Hans Zimmer - The Immersive Symphony', search: 'The World Of Hans Zimmer - The Immersive Symphony', genre: 'Live Music', description: 'The World Of Hans Zimmer - The Immersive Symphony are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'viagra-boys', name: 'Viagra Boys', search: 'Viagra Boys', genre: 'Live Music', description: 'Viagra Boys are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ireland-v-wales-six-nations', name: 'Ireland v Wales - Six Nations', search: 'Ireland v Wales - Six Nations', genre: 'Sports', description: 'Ireland v Wales - Six Nations are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'country-to-country-weekend-pass', name: 'Country to Country: Weekend Pass', search: 'Country to Country: Weekend Pass', genre: 'Live Music', description: 'Country to Country: Weekend Pass are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'giveon', name: 'Giveon', search: 'Giveon', genre: 'Live Music', description: 'Giveon are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'olly', name: 'Olly', search: 'Olly', genre: 'Live Music', description: 'Olly are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'powerwolf-hammerfall', name: 'Powerwolf & Hammerfall', search: 'Powerwolf & Hammerfall', genre: 'Live Music', description: 'Powerwolf & Hammerfall are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ub40', name: 'UB40', search: 'UB40', genre: 'Live Music', description: 'UB40 are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'zach-bryan', name: 'Zach Bryan', search: 'Zach Bryan', genre: 'Live Music', description: 'Zach Bryan are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lara-fabian', name: 'Lara Fabian', search: 'Lara Fabian', genre: 'Live Music', description: 'Lara Fabian are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: '10cc', name: '10cc', search: '10cc', genre: 'Live Music', description: '10cc are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'plk', name: 'PLK', search: 'PLK', genre: 'Live Music', description: 'PLK are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jid', name: 'J.I.D', search: 'J.I.D', genre: 'Live Music', description: 'J.I.D are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bbno', name: 'bbno onRequestGet({ request, env }) {
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
}, search: 'bbno onRequestGet({ request, env }) {
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
}, genre: 'Live Music', description: 'bbno$ are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'stiff-little-fingers', name: 'Stiff Little Fingers', search: 'Stiff Little Fingers', genre: 'Live Music', description: 'Stiff Little Fingers are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ken-carson', name: 'Ken Carson', search: 'Ken Carson', genre: 'Live Music', description: 'Ken Carson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'renee-rapp', name: 'Renee Rapp', search: 'Renee Rapp', genre: 'Live Music', description: 'Renee Rapp are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tash-sultana', name: 'Tash Sultana', search: 'Tash Sultana', genre: 'Live Music', description: 'Tash Sultana are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'alex-james', name: 'Alex James', search: 'Alex James', genre: 'Live Music', description: 'Alex James are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'eden', name: 'Eden', search: 'Eden', genre: 'Live Music', description: 'Eden are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nightmares-on-wax', name: 'Nightmares on Wax', search: 'Nightmares on Wax', genre: 'Live Music', description: 'Nightmares on Wax are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'country-to-country-3-day-ticket', name: 'Country to Country: 3 Day Ticket', search: 'Country to Country: 3 Day Ticket', genre: 'Live Music', description: 'Country to Country: 3 Day Ticket are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'off-menu', name: 'Off Menu', search: 'Off Menu', genre: 'Live Music', description: 'Off Menu are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cheltenham-festival-gold-cup-day', name: 'Cheltenham Festival: Gold Cup Day', search: 'Cheltenham Festival: Gold Cup Day', genre: 'Sports', description: 'Cheltenham Festival: Gold Cup Day are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'asha-banks', name: 'Asha Banks', search: 'Asha Banks', genre: 'Live Music', description: 'Asha Banks are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'headbangers-parade-poppy', name: 'Headbangers Parade: Poppy', search: 'Headbangers Parade: Poppy', genre: 'Live Music', description: 'Headbangers Parade: Poppy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sub-focus', name: 'Sub Focus', search: 'Sub Focus', genre: 'Live Music', description: 'Sub Focus are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'echo-and-the-bunnymen', name: 'Echo and the Bunnymen', search: 'Echo and the Bunnymen', genre: 'Live Music', description: 'Echo and the Bunnymen are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sergio-dalma', name: 'Sergio Dalma', search: 'Sergio Dalma', genre: 'Live Music', description: 'Sergio Dalma are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nathan-carter-and-his-band', name: 'Nathan Carter and His Band', search: 'Nathan Carter and His Band', genre: 'Live Music', description: 'Nathan Carter and His Band are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'daniel-sloss', name: 'Daniel Sloss', search: 'Daniel Sloss', genre: 'Live Music', description: 'Daniel Sloss are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'arthur-hill', name: 'Arthur Hill', search: 'Arthur Hill', genre: 'Live Music', description: 'Arthur Hill are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'billy-joel', name: 'Billy Joel', search: 'Billy Joel', genre: 'Live Music', description: 'Billy Joel are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'one-ok-rock', name: 'One Ok Rock', search: 'One Ok Rock', genre: 'Live Music', description: 'One Ok Rock are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jason-manford', name: 'Jason Manford', search: 'Jason Manford', genre: 'Live Music', description: 'Jason Manford are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'theodora', name: 'Theodora', search: 'Theodora', genre: 'Live Music', description: 'Theodora are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rosalia', name: 'Rosalia', search: 'Rosalia', genre: 'Live Music', description: 'Rosalia are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'diversity', name: 'Diversity', search: 'Diversity', genre: 'Live Music', description: 'Diversity are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bonnie-tyler', name: 'Bonnie Tyler', search: 'Bonnie Tyler', genre: 'Live Music', description: 'Bonnie Tyler are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gigi-dalessio', name: 'Gigi D\'Alessio', search: 'Gigi D\'Alessio', genre: 'Live Music', description: 'Gigi D\'Alessio are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nmixx', name: 'NMIXX', search: 'NMIXX', genre: 'Live Music', description: 'NMIXX are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'azahriah', name: 'Azahriah', search: 'Azahriah', genre: 'Live Music', description: 'Azahriah are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'clair-obscur-expedition-33', name: 'Clair Obscur: Expedition 33', search: 'Clair Obscur: Expedition 33', genre: 'Live Music', description: 'Clair Obscur: Expedition 33 are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ernia', name: 'Ernia', search: 'Ernia', genre: 'Live Music', description: 'Ernia are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'james-acaster', name: 'James Acaster', search: 'James Acaster', genre: 'Live Music', description: 'James Acaster are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jimmy-sax', name: 'Jimmy Sax', search: 'Jimmy Sax', genre: 'Live Music', description: 'Jimmy Sax are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'leon-thomas', name: 'Leon Thomas', search: 'Leon Thomas', genre: 'Live Music', description: 'Leon Thomas are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'foreigner', name: 'Foreigner', search: 'Foreigner', genre: 'Live Music', description: 'Foreigner are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gorillaz', name: 'Gorillaz', search: 'Gorillaz', genre: 'Live Music', description: 'Gorillaz are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'molly-sanden', name: 'Molly Sanden', search: 'Molly Sanden', genre: 'Live Music', description: 'Molly Sanden are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'bouke-and-the-elvismatters-band', name: 'Bouke and The ElvisMatters Band', search: 'Bouke and The ElvisMatters Band', genre: 'Live Music', description: 'Bouke and The ElvisMatters Band are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gunna', name: 'Gunna', search: 'Gunna', genre: 'Live Music', description: 'Gunna are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'adelboden-live-ub40', name: 'Adelboden Live: UB40', search: 'Adelboden Live: UB40', genre: 'Live Music', description: 'Adelboden Live: UB40 are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'squeeze', name: 'Squeeze', search: 'Squeeze', genre: 'Live Music', description: 'Squeeze are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cage-warriors-203', name: 'Cage Warriors 203', search: 'Cage Warriors 203', genre: 'Sports', description: 'Cage Warriors 203 are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'josh-widdicombe', name: 'Josh Widdicombe', search: 'Josh Widdicombe', genre: 'Live Music', description: 'Josh Widdicombe are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gabriel-iglesias', name: 'Gabriel Iglesias', search: 'Gabriel Iglesias', genre: 'Live Music', description: 'Gabriel Iglesias are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-saturday', name: 'Tomorrowland: Saturday', search: 'Tomorrowland: Saturday', genre: 'Live Music', description: 'Tomorrowland: Saturday are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-sunday', name: 'Tomorrowland: Sunday', search: 'Tomorrowland: Sunday', genre: 'Live Music', description: 'Tomorrowland: Sunday are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'badshah', name: 'Badshah', search: 'Badshah', genre: 'Live Music', description: 'Badshah are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-monday', name: 'Tomorrowland: Monday', search: 'Tomorrowland: Monday', genre: 'Live Music', description: 'Tomorrowland: Monday are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'louis-tomlinson', name: 'Louis Tomlinson', search: 'Louis Tomlinson', genre: 'Live Music', description: 'Louis Tomlinson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'richard-ashcroft', name: 'Richard Ashcroft', search: 'Richard Ashcroft', genre: 'Live Music', description: 'Richard Ashcroft are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-4-day-pass', name: 'Tomorrowland: 4 Day Pass', search: 'Tomorrowland: 4 Day Pass', genre: 'Live Music', description: 'Tomorrowland: 4 Day Pass are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-tuesday', name: 'Tomorrowland: Tuesday', search: 'Tomorrowland: Tuesday', genre: 'Live Music', description: 'Tomorrowland: Tuesday are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-wednesday', name: 'Tomorrowland: Wednesday', search: 'Tomorrowland: Wednesday', genre: 'Live Music', description: 'Tomorrowland: Wednesday are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'davido', name: 'Davido', search: 'Davido', genre: 'Live Music', description: 'Davido are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'djo', name: 'Djo', search: 'Djo', genre: 'Live Music', description: 'Djo are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tomorrowland-thursday', name: 'Tomorrowland: Thursday', search: 'Tomorrowland: Thursday', genre: 'Live Music', description: 'Tomorrowland: Thursday are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'odeal', name: 'Odeal', search: 'Odeal', genre: 'Live Music', description: 'Odeal are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mt-joy', name: 'Mt. Joy', search: 'Mt. Joy', genre: 'Live Music', description: 'Mt. Joy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'vanessa-paradis', name: 'Vanessa Paradis', search: 'Vanessa Paradis', genre: 'Live Music', description: 'Vanessa Paradis are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'laura-pausini', name: 'Laura Pausini', search: 'Laura Pausini', genre: 'Live Music', description: 'Laura Pausini are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'henry-moodie', name: 'Henry Moodie', search: 'Henry Moodie', genre: 'Live Music', description: 'Henry Moodie are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'blast-premier-open', name: 'Blast Premier Open', search: 'Blast Premier Open', genre: 'Sports', description: 'Blast Premier Open are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'blast-premier-open-3-day-ticket', name: 'Blast Premier Open: 3 Day Ticket', search: 'Blast Premier Open: 3 Day Ticket', genre: 'Sports', description: 'Blast Premier Open: 3 Day Ticket are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'smokey-robinson', name: 'Smokey Robinson', search: 'Smokey Robinson', genre: 'Live Music', description: 'Smokey Robinson are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'basement-jaxx', name: 'Basement Jaxx', search: 'Basement Jaxx', genre: 'Live Music', description: 'Basement Jaxx are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'derren-brown', name: 'Derren Brown', search: 'Derren Brown', genre: 'Live Music', description: 'Derren Brown are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'josh-groban', name: 'Josh Groban', search: 'Josh Groban', genre: 'Live Music', description: 'Josh Groban are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'stornoway', name: 'Stornoway', search: 'Stornoway', genre: 'Live Music', description: 'Stornoway are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: '5-seconds-of-summer', name: '5 Seconds of Summer', search: '5 Seconds of Summer', genre: 'Live Music', description: '5 Seconds of Summer are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'freddie-gibbs', name: 'Freddie Gibbs', search: 'Freddie Gibbs', genre: 'Live Music', description: 'Freddie Gibbs are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ichiko-aoba', name: 'Ichiko Aoba', search: 'Ichiko Aoba', genre: 'Live Music', description: 'Ichiko Aoba are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tyler-the-creator', name: 'Tyler, The Creator', search: 'Tyler, The Creator', genre: 'Live Music', description: 'Tyler, The Creator are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'masayoshi-takanaka', name: 'Masayoshi Takanaka', search: 'Masayoshi Takanaka', genre: 'Live Music', description: 'Masayoshi Takanaka are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'scorpions', name: 'Scorpions', search: 'Scorpions', genre: 'Live Music', description: 'Scorpions are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'vir-das', name: 'Vir Das', search: 'Vir Das', genre: 'Live Music', description: 'Vir Das are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mark-mccabe', name: 'Mark McCabe', search: 'Mark McCabe', genre: 'Live Music', description: 'Mark McCabe are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'calum-scott', name: 'Calum Scott', search: 'Calum Scott', genre: 'Live Music', description: 'Calum Scott are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'james', name: 'James', search: 'James', genre: 'Live Music', description: 'James are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'alex-warren', name: 'Alex Warren', search: 'Alex Warren', genre: 'Live Music', description: 'Alex Warren are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-saturday', name: 'Rolex Monte-Carlo Masters: Saturday', search: 'Rolex Monte-Carlo Masters: Saturday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Saturday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'monsters-of-rock-guns-n-roses', name: 'Monsters of Rock: Guns N\' Roses', search: 'Monsters of Rock: Guns N\' Roses', genre: 'Live Music', description: 'Monsters of Rock: Guns N\' Roses are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'chris-stussy', name: 'Chris Stussy', search: 'Chris Stussy', genre: 'Live Music', description: 'Chris Stussy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-sunday', name: 'Rolex Monte-Carlo Masters: Sunday', search: 'Rolex Monte-Carlo Masters: Sunday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Sunday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'interstellar-live', name: 'Interstellar Live', search: 'Interstellar Live', genre: 'Live Music', description: 'Interstellar Live are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-monday', name: 'Rolex Monte-Carlo Masters: Monday', search: 'Rolex Monte-Carlo Masters: Monday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Monday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'leigh-anne-pinnock', name: 'Leigh-Anne Pinnock', search: 'Leigh-Anne Pinnock', genre: 'Live Music', description: 'Leigh-Anne Pinnock are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'pet-shop-boys', name: 'Pet Shop Boys', search: 'Pet Shop Boys', genre: 'Live Music', description: 'Pet Shop Boys are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'wololo-londinium-age-of-empires-ii', name: 'Wololo: Londinium Age of Empires II', search: 'Wololo: Londinium Age of Empires II', genre: 'Sports', description: 'Wololo: Londinium Age of Empires II are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'max-cooper', name: 'Max Cooper', search: 'Max Cooper', genre: 'Live Music', description: 'Max Cooper are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-tuesday', name: 'Rolex Monte-Carlo Masters: Tuesday', search: 'Rolex Monte-Carlo Masters: Tuesday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Tuesday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'zara-larsson-with-amelia-moore', name: 'Zara Larsson with Amelia Moore', search: 'Zara Larsson with Amelia Moore', genre: 'Live Music', description: 'Zara Larsson with Amelia Moore are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'ninja-sex-party', name: 'Ninja Sex Party', search: 'Ninja Sex Party', genre: 'Live Music', description: 'Ninja Sex Party are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'jessie-j', name: 'Jessie J', search: 'Jessie J', genre: 'Live Music', description: 'Jessie J are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'blue', name: 'Blue', search: 'Blue', genre: 'Live Music', description: 'Blue are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-wednesday', name: 'Rolex Monte-Carlo Masters: Wednesday', search: 'Rolex Monte-Carlo Masters: Wednesday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Wednesday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tori-amos', name: 'Tori Amos', search: 'Tori Amos', genre: 'Live Music', description: 'Tori Amos are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'craig-david', name: 'Craig David', search: 'Craig David', genre: 'Live Music', description: 'Craig David are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-thursday', name: 'Rolex Monte-Carlo Masters: Thursday', search: 'Rolex Monte-Carlo Masters: Thursday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Thursday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'billy-joel-and-sting', name: 'Billy Joel and Sting', search: 'Billy Joel and Sting', genre: 'Live Music', description: 'Billy Joel and Sting are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rick-astley', name: 'Rick Astley', search: 'Rick Astley', genre: 'Live Music', description: 'Rick Astley are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'coachella-music-festival-weekend-1-3-day-pass', name: 'Coachella Music Festival Weekend 1 - 3 Day Pass', search: 'Coachella Music Festival Weekend 1 - 3 Day Pass', genre: 'Live Music', description: 'Coachella Music Festival Weekend 1 - 3 Day Pass are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rolex-monte-carlo-masters-friday', name: 'Rolex Monte-Carlo Masters: Friday', search: 'Rolex Monte-Carlo Masters: Friday', genre: 'Sports', description: 'Rolex Monte-Carlo Masters: Friday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cat-burns', name: 'Cat Burns', search: 'Cat Burns', genre: 'Live Music', description: 'Cat Burns are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'morgan-wallen', name: 'Morgan Wallen', search: 'Morgan Wallen', genre: 'Live Music', description: 'Morgan Wallen are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'shreya-ghoshal', name: 'Shreya Ghoshal', search: 'Shreya Ghoshal', genre: 'Live Music', description: 'Shreya Ghoshal are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'nurse-john', name: 'Nurse John', search: 'Nurse John', genre: 'Live Music', description: 'Nurse John are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'paul-mirabel', name: 'Paul Mirabel', search: 'Paul Mirabel', genre: 'Live Music', description: 'Paul Mirabel are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'grand-national-national-day', name: 'Grand National: National Day', search: 'Grand National: National Day', genre: 'Sports', description: 'Grand National: National Day are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'skye-newman', name: 'Skye Newman', search: 'Skye Newman', genre: 'Live Music', description: 'Skye Newman are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'lany', name: 'Lany', search: 'Lany', genre: 'Live Music', description: 'Lany are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'president', name: 'President', search: 'President', genre: 'Live Music', description: 'President are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'hayley-williams', name: 'Hayley Williams', search: 'Hayley Williams', genre: 'Live Music', description: 'Hayley Williams are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-prodigy', name: 'The Prodigy', search: 'The Prodigy', genre: 'Live Music', description: 'The Prodigy are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'gianni-morandi', name: 'Gianni Morandi', search: 'Gianni Morandi', genre: 'Live Music', description: 'Gianni Morandi are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saudi-arabian-f1-gp-4-day-pass', name: 'Saudi Arabian F1 GP - 4 Day Pass', search: 'Saudi Arabian F1 GP - 4 Day Pass', genre: 'Sports', description: 'Saudi Arabian F1 GP - 4 Day Pass are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'skillet', name: 'Skillet', search: 'Skillet', genre: 'Live Music', description: 'Skillet are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'blanco', name: 'Blanco', search: 'Blanco', genre: 'Live Music', description: 'Blanco are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'sammy-virji', name: 'Sammy Virji', search: 'Sammy Virji', genre: 'Live Music', description: 'Sammy Virji are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saudi-arabian-f1-gp-friday', name: 'Saudi Arabian F1 GP - Friday', search: 'Saudi Arabian F1 GP - Friday', genre: 'Sports', description: 'Saudi Arabian F1 GP - Friday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'coachella-music-festival-weekend-2-3-day-pass', name: 'Coachella Music Festival Weekend 2 - 3 Day Pass', search: 'Coachella Music Festival Weekend 2 - 3 Day Pass', genre: 'Live Music', description: 'Coachella Music Festival Weekend 2 - 3 Day Pass are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'john-mulaney', name: 'John Mulaney', search: 'John Mulaney', genre: 'Live Music', description: 'John Mulaney are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'world-snooker-championship', name: 'World Snooker Championship', search: 'World Snooker Championship', genre: 'Sports', description: 'World Snooker Championship are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tommaso-paradiso', name: 'Tommaso Paradiso', search: 'Tommaso Paradiso', genre: 'Live Music', description: 'Tommaso Paradiso are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saudi-arabian-f1-gp-saturday', name: 'Saudi Arabian F1 GP - Saturday', search: 'Saudi Arabian F1 GP - Saturday', genre: 'Sports', description: 'Saudi Arabian F1 GP - Saturday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'amber-mark', name: 'Amber Mark', search: 'Amber Mark', genre: 'Live Music', description: 'Amber Mark are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'cooper-alan', name: 'Cooper Alan', search: 'Cooper Alan', genre: 'Live Music', description: 'Cooper Alan are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'troy-hawke', name: 'Troy Hawke', search: 'Troy Hawke', genre: 'Live Music', description: 'Troy Hawke are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'barcelona-open-banc-sabadell-semifinals', name: 'Barcelona Open Banc Sabadell - Semifinals', search: 'Barcelona Open Banc Sabadell - Semifinals', genre: 'Sports', description: 'Barcelona Open Banc Sabadell - Semifinals are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'saudi-arabian-f1-gp-sunday', name: 'Saudi Arabian F1 GP - Sunday', search: 'Saudi Arabian F1 GP - Sunday', genre: 'Sports', description: 'Saudi Arabian F1 GP - Sunday are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'alfa', name: 'Alfa', search: 'Alfa', genre: 'Live Music', description: 'Alfa are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'mutua-madrid-open', name: 'Mutua Madrid Open', search: 'Mutua Madrid Open', genre: 'Sports', description: 'Mutua Madrid Open are a renowned Sports act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'the-weeknd-with-playboi-carti', name: 'The Weeknd with Playboi Carti', search: 'The Weeknd with Playboi Carti', genre: 'Live Music', description: 'The Weeknd with Playboi Carti are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'naza', name: 'Naza', search: 'Naza', genre: 'Live Music', description: 'Naza are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'alfie-boe', name: 'Alfie Boe', search: 'Alfie Boe', genre: 'Live Music', description: 'Alfie Boe are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'tucker-wetmore', name: 'Tucker Wetmore', search: 'Tucker Wetmore', genre: 'Live Music', description: 'Tucker Wetmore are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'olivia-dean', name: 'Olivia Dean', search: 'Olivia Dean', genre: 'Live Music', description: 'Olivia Dean are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'joe-bonamassa', name: 'Joe Bonamassa', search: 'Joe Bonamassa', genre: 'Live Music', description: 'Joe Bonamassa are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'rufus-du-sol', name: 'Rufus Du Sol', search: 'Rufus Du Sol', genre: 'Live Music', description: 'Rufus Du Sol are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'deep-purple', name: 'Deep Purple', search: 'Deep Purple', genre: 'Live Music', description: 'Deep Purple are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'inji', name: 'Inji', search: 'Inji', genre: 'Live Music', description: 'Inji are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'amaarae', name: 'Amaarae', search: 'Amaarae', genre: 'Live Music', description: 'Amaarae are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
  { slug: 'angelo-pintus', name: 'Angelo Pintus', search: 'Angelo Pintus', genre: 'Live Music', description: 'Angelo Pintus are a renowned Live Music act known for their captivating live performances. Compare ticket prices across verified sellers on TicketScout.' },
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