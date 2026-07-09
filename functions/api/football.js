// ===========================
// TicketScout — Football team page handler
// Runs as a Cloudflare Pages Function at /api/football
// ===========================

const TEAMS = [
  { slug: 'arsenal',              name: 'Arsenal',                 search: 'Arsenal',               tmSearch: 'Arsenal FC',              genre: 'Football', description: 'Arsenal Football Club are one of England\'s most successful clubs, based at the Emirates Stadium in north London. With 13 First Division/Premier League titles and a record 14 FA Cups, the Gunners are one of the most widely supported clubs in the world. Under Mikel Arteta, Arsenal have returned to genuine Premier League title contention.' },
  { slug: 'chelsea',              name: 'Chelsea',                 search: 'Chelsea',               tmSearch: 'Chelsea FC',              genre: 'Football', description: 'Chelsea Football Club, based at Stamford Bridge in west London, are one of England\'s most decorated clubs. With six Premier League titles, multiple Champions League and Europa League wins, Chelsea are a global brand with one of the largest fanbases in world football.' },
  { slug: 'liverpool',            name: 'Liverpool',               search: 'Liverpool',             tmSearch: 'Liverpool FC',            genre: 'Football', description: 'Liverpool FC are one of England\'s most successful clubs and a genuine giant of European football. 19-time English champions and six-time European Cup/Champions League winners, the Reds play at the legendary Anfield stadium and are known worldwide for their passionate supporters.' },
  { slug: 'manchester-united',    name: 'Manchester United',       search: 'Manchester United',     tmSearch: 'Manchester United',       genre: 'Football', description: 'Manchester United are England\'s most successful club by league titles, with 20 First Division/Premier League championships. Based at Old Trafford, United are one of the most widely supported clubs on the planet with a global fanbase estimated at over 1 billion.' },
  { slug: 'manchester-city',      name: 'Manchester City',         search: 'Manchester City',       tmSearch: 'Manchester City',         genre: 'Football', description: 'Manchester City are the current dominant force in English football under Pep Guardiola, having won six of the last eight Premier League titles. City became England\'s first treble winners in 2023 and play at the Etihad Stadium.' },
  { slug: 'tottenham',            name: 'Tottenham Hotspur',       search: 'Tottenham',             tmSearch: 'Tottenham Hotspur',       genre: 'Football', description: 'Tottenham Hotspur are a major north London club based at their stunning new Tottenham Hotspur Stadium. Spurs have a rich history including back-to-back league titles in 1960/61 and reached the Champions League final in 2019.' },
  { slug: 'newcastle',            name: 'Newcastle United',        search: 'Newcastle',             tmSearch: 'Newcastle United',        genre: 'Football', description: 'Newcastle United are a historic north-east club backed by one of the most passionate fanbases in England. Following their 2021 Saudi-led takeover, Newcastle have invested heavily in the squad and are re-establishing themselves among the Premier League\'s top clubs under Eddie Howe.' },
  { slug: 'aston-villa',          name: 'Aston Villa',             search: 'Aston Villa',           tmSearch: 'Aston Villa',             genre: 'Football', description: 'Aston Villa are one of English football\'s founding clubs and European Cup winners in 1982. Based at Villa Park in Birmingham, the club have returned to contending for European qualification under Unai Emery.' },
  { slug: 'west-ham',             name: 'West Ham United',         search: 'West Ham',              tmSearch: 'West Ham United',         genre: 'Football', description: 'West Ham United, based at the London Stadium, are a proud east London club. They produced legends like Bobby Moore, Geoff Hurst and Martin Peters, and won the Europa Conference League in 2023.' },
  { slug: 'brighton',             name: 'Brighton & Hove Albion',  search: 'Brighton',              tmSearch: 'Brighton & Hove Albion',  genre: 'Football', description: 'Brighton & Hove Albion have become one of the Premier League\'s most admired clubs, renowned for their progressive playing style and data-driven recruitment. The Seagulls play at the Amex Stadium.' },
  { slug: 'everton',              name: 'Everton',                 search: 'Everton',               tmSearch: 'Everton FC',              genre: 'Football', description: 'Everton are a founding member of the Football League and one of English football\'s most historic clubs. The Toffees are set to move to their new waterfront stadium at Bramley-Moore Dock.' },
  { slug: 'rangers',              name: 'Rangers',                 search: 'Rangers',               tmSearch: 'Rangers FC',              genre: 'Football', description: 'Rangers FC are one of the most successful clubs in world football by domestic titles, with 55 Scottish top-flight championships. Based at Ibrox Stadium in Glasgow, Rangers are one half of the famous Old Firm rivalry.' },
  { slug: 'celtic',               name: 'Celtic',                  search: 'Celtic',                tmSearch: 'Celtic FC',               genre: 'Football', description: 'Celtic are Scotland\'s most successful club in European competition and one of the few British clubs to have won the European Cup, lifting the trophy in 1967. Based at Celtic Park in Glasgow, the club has a massive global following.' },
  { slug: 'leeds-united',         name: 'Leeds United',            search: 'Leeds United',          tmSearch: 'Leeds United',            genre: 'Football', description: 'Leeds United are a passionate Yorkshire club with a proud history including two First Division titles and a European Fairs Cup win. Known for their fervent fanbase and the iconic Elland Road ground.' },
  { slug: 'wolves',               name: 'Wolverhampton Wanderers', search: 'Wolves',                tmSearch: 'Wolverhampton Wanderers', genre: 'Football', description: 'Wolverhampton Wanderers, known as Wolves, are a historic Midlands club who have established themselves back in the Premier League. Playing at Molineux, Wolves have a loyal fanbase and strong European football heritage.' },
  { slug: 'fulham',               name: 'Fulham',                  search: 'Fulham',                tmSearch: 'Fulham FC',               genre: 'Football', description: 'Fulham FC are a west London club based at the iconic Craven Cottage on the banks of the Thames. Having established themselves back in the Premier League, Fulham are known for their community spirit and one of English football\'s most picturesque grounds.' },
  { slug: 'brentford',            name: 'Brentford',               search: 'Brentford',             tmSearch: 'Brentford FC',            genre: 'Football', description: 'Brentford FC are a west London club who have established themselves in the Premier League following their 2021 promotion. Playing at the modern Gtech Community Stadium, Brentford are known for their innovative data-driven approach under Thomas Frank.' },
  { slug: 'bournemouth',          name: 'Bournemouth',             search: 'Bournemouth',           tmSearch: 'AFC Bournemouth',         genre: 'Football', description: 'AFC Bournemouth are a south coast club who have become established Premier League regulars. Playing at the Vitality Stadium, the Cherries have punched above their weight and continue to attract top-level talent.' },
  { slug: 'crystal-palace',       name: 'Crystal Palace',          search: 'Crystal Palace',        tmSearch: 'Crystal Palace',          genre: 'Football', description: 'Crystal Palace are a south London club with a passionate fanbase and one of the Premier League\'s most atmospheric grounds in Selhurst Park. Known for their eagle mascot and vibrant supporter culture.' },
  { slug: 'nottingham-forest',    name: 'Nottingham Forest',       search: 'Nottingham Forest',     tmSearch: 'Nottingham Forest',       genre: 'Football', description: 'Nottingham Forest are one of English football\'s most storied clubs, having won the European Cup back-to-back in 1979 and 1980. Having returned to the Premier League, Forest are competing at the highest level at the City Ground.' },
  { slug: 'leicester-city',       name: 'Leicester City',          search: 'Leicester City',        tmSearch: 'Leicester City',          genre: 'Football', description: 'Leicester City are famous for their extraordinary Premier League title win in 2015-16, widely regarded as one of the greatest sporting upsets of all time. The Foxes play at the King Power Stadium.' },
  { slug: 'southampton',          name: 'Southampton',             search: 'Southampton',           tmSearch: 'Southampton FC',          genre: 'Football', description: 'Southampton FC, known as the Saints, are a historic south coast club famed for their youth academy which produced legends including Alan Shearer and Gareth Bale. Southampton play at St Mary\'s Stadium.' },
  { slug: 'ipswich',              name: 'Ipswich Town',            search: 'Ipswich',               tmSearch: 'Ipswich Town',            genre: 'Football', description: 'Ipswich Town are a Suffolk club with a proud history including a First Division title in 1962 and UEFA Cup win in 1981. After years away, Ipswich have returned to the Premier League under Kieran McKenna.' },
  { slug: 'watford',              name: 'Watford',                 search: 'Watford',               tmSearch: 'Watford FC',              genre: 'Football', description: 'Watford FC are a Hertfordshire club with a rich history. The Hornets yo-yo between the Premier League and Championship and play at Vicarage Road, one of the most distinctive grounds in English football.' },
  { slug: 'stoke-city',           name: 'Stoke City',              search: 'Stoke City',            tmSearch: 'Stoke City',              genre: 'Football', description: 'Stoke City are a proud Midlands club and one of the 12 founding members of the Football League. The Potters play at the bet365 Stadium and have a loyal Potteries fanbase with ambitions to return to the top flight.' },
  { slug: 'sheffield-united',     name: 'Sheffield United',        search: 'Sheffield United',      tmSearch: 'Sheffield United',        genre: 'Football', description: 'Sheffield United are a Yorkshire club competing in the Championship with ambitions to return to the Premier League. The Blades play at the historic Bramall Lane, one of the world\'s oldest major football stadiums still in use.' },
  { slug: 'sheffield-wednesday',  name: 'Sheffield Wednesday',     search: 'Sheffield Wednesday',   tmSearch: 'Sheffield Wednesday',     genre: 'Football', description: 'Sheffield Wednesday are a historic Yorkshire club and one of England\'s oldest professional football clubs. The Owls play at Hillsborough and have a passionate fanbase with strong ambitions to return to the Premier League.' },
  { slug: 'sunderland',           name: 'Sunderland',              search: 'Sunderland',            tmSearch: 'Sunderland AFC',          genre: 'Football', description: 'Sunderland AFC are a north-east club with a passionate fanbase and storied history. Sunderland have attracted renewed attention following the Netflix documentary series and play at the Stadium of Light.' },
  { slug: 'middlesbrough',        name: 'Middlesbrough',           search: 'Middlesbrough',         tmSearch: 'Middlesbrough FC',        genre: 'Football', description: 'Middlesbrough FC are a north-east club competing in the Championship. Boro won the League Cup in 2004 and reached the UEFA Cup final in 2006, and they continue to push for a return to the top flight at the Riverside Stadium.' },
  { slug: 'hearts',               name: 'Heart of Midlothian',     search: 'Hearts',                tmSearch: 'Heart of Midlothian',     genre: 'Football', description: 'Heart of Midlothian, known as Hearts, are one of Scotland\'s most successful clubs based in Edinburgh. Hearts play at Tynecastle Park and are one half of the Edinburgh derby rivalry with Hibernian.' },
  { slug: 'hibernian',            name: 'Hibernian',               search: 'Hibernian',             tmSearch: 'Hibernian FC',            genre: 'Football', description: 'Hibernian FC, known as Hibs, are an Edinburgh club with a rich history and a famous European pedigree. They were the first British club to play in European competition. Hibs play at Easter Road and are fierce Edinburgh derby rivals with Hearts.' }
,

  // ── European Leagues ─────────────────────────────────────────────────────

  // La Liga (Spain)
  { slug: 'fc-barcelona', name: 'FC Barcelona', search: 'FC Barcelona', tmSearch: 'FC Barcelona', genre: 'Football', description: 'FC Barcelona are one of the most celebrated clubs in world football, playing at the Spotify Camp Nou. With 27 La Liga titles and 5 Champions League trophies, Barca are famed for their attacking style and legendary players including Messi and Cruyff.' },
  { slug: 'real-madrid', name: 'Real Madrid', search: 'Real Madrid', tmSearch: 'Real Madrid', genre: 'Football', description: 'Real Madrid are the most decorated club in European football history, having won a record 15 Champions League titles. Based at the Santiago Bernabeu, Los Blancos are the most valuable football club in the world.' },
  { slug: 'atletico-madrid', name: 'Atletico Madrid', search: 'Atletico Madrid', tmSearch: 'Atletico de Madrid', genre: 'Football', description: 'Atletico Madrid are a major Spanish club based at the Estadio Metropolitano. Under Diego Simeone they have won La Liga twice and reached the Champions League final twice, known for their tenacious defensive style.' },
  { slug: 'sevilla', name: 'Sevilla FC', search: 'Sevilla', tmSearch: 'Sevilla FC', genre: 'Football', description: 'Sevilla FC are a major Spanish club and the most successful team in Europa League history with seven titles. Based at the Ramon Sanchez-Pizjuan stadium, Sevilla are a regular Champions League participant.' },
  { slug: 'real-sociedad', name: 'Real Sociedad', search: 'Real Sociedad', tmSearch: 'Real Sociedad', genre: 'Football', description: 'Real Sociedad are a Basque club from San Sebastian and one of the most exciting teams in Spanish football, known for developing local talent and playing attractive football with regular European participation.' },
  { slug: 'villarreal', name: 'Villarreal CF', search: 'Villarreal', tmSearch: 'Villarreal CF', genre: 'Football', description: 'Villarreal CF, the Yellow Submarine, won the Europa League in 2021 defeating Manchester United on penalties. Based in Castellon, Villarreal are regularly competitive in European competition under smart management.' },
  { slug: 'athletic-bilbao', name: 'Athletic Bilbao', search: 'Athletic Bilbao', tmSearch: 'Athletic Club', genre: 'Football', description: 'Athletic Bilbao are a unique Spanish club who field only players from the Basque Country. One of only three clubs never relegated from La Liga, Athletic are a proud institution with passionate fans at the San Mames.' },
  { slug: 'real-betis', name: 'Real Betis', search: 'Real Betis', tmSearch: 'Real Betis', genre: 'Football', description: 'Real Betis Balompie are a Seville club and Copa del Rey winners in 2022. Playing attacking football at the Estadio Benito Villamarin, Betis have become a regular presence in European competition with a passionate following.' },
  { slug: 'valencia', name: 'Valencia CF', search: 'Valencia', tmSearch: 'Valencia CF', genre: 'Football', description: 'Valencia CF are a historic Spanish club and two-time Champions League finalists. Based at the Mestalla stadium, Los Che have a proud European pedigree and passionate following in the third largest city in Spain.' },
  { slug: 'getafe', name: 'Getafe CF', search: 'Getafe', tmSearch: 'Getafe CF', genre: 'Football', description: 'Getafe CF are a Madrid-based club known for their physical and combative style of play, having established themselves as a competitive La Liga presence and proven capable of results against the biggest clubs.' },
  { slug: 'osasuna', name: 'CA Osasuna', search: 'Osasuna', tmSearch: 'CA Osasuna', genre: 'Football', description: 'CA Osasuna are a Navarre club based in Pamplona famous for their Copa del Rey appearances and the passionate atmosphere at El Sadar. Osasuna are known for their community spirit and fiercely loyal fanbase.' },
  { slug: 'rayo-vallecano', name: 'Rayo Vallecano', search: 'Rayo Vallecano', tmSearch: 'Rayo Vallecano', genre: 'Football', description: 'Rayo Vallecano are a Madrid club with a strong working-class identity and one of the most politically active fanbases in Spanish football. Known as the People\'s team of Madrid, Rayo play at Vallecas.' },
  { slug: 'celta-vigo', name: 'Celta Vigo', search: 'Celta Vigo', tmSearch: 'Celta de Vigo', genre: 'Football', description: 'Celta Vigo are a Galician club playing at Balaidos stadium. Known for producing technical players and playing attractive football, Celta have had several successful European runs and a passionate Galician following.' },
  { slug: 'espanyol', name: 'RCD Espanyol', search: 'Espanyol', tmSearch: 'RCD Espanyol', genre: 'Football', description: 'RCD Espanyol are Barcelona\'s second club, playing at the RCDE Stadium. A Copa del Rey winner and regular La Liga participant, Espanyol have a proud identity separate from their city rivals.' },
  { slug: 'mallorca', name: 'RCD Mallorca', search: 'Mallorca', tmSearch: 'RCD Mallorca', genre: 'Football', description: 'RCD Mallorca are the main club of the Balearic Islands, playing at the Estadio de Son Moix in Palma. Mallorca have a long history in La Liga and attract significant support from the island and its many visitors.' },
  { slug: 'girona', name: 'Girona FC', search: 'Girona', tmSearch: 'Girona FC', genre: 'Football', description: 'Girona FC are a Catalan club who made history in 2023-24 by finishing third in La Liga and reaching the Champions League. Backed by the City Football Group, Girona have quickly established themselves among the top clubs in Spain.' },
  { slug: 'alaves', name: 'Deportivo Alaves', search: 'Alaves', tmSearch: 'Deportivo Alaves', genre: 'Football', description: 'Deportivo Alaves are a Basque club from Vitoria-Gasteiz who famously reached the UEFA Cup final in 2001. Playing at Mendizorroza, Alaves compete in La Liga with a loyal local following and fighting spirit.' },
  { slug: 'leganes', name: 'CD Leganes', search: 'Leganes', tmSearch: 'CD Leganes', genre: 'Football', description: 'CD Leganes are a Madrid suburb club who have established themselves in La Liga. Known as the Cucumbers, Leganes play at the Estadio Municipal de Butarque and represent one of football\'s great underdog stories.' },
  { slug: 'las-palmas', name: 'UD Las Palmas', search: 'Las Palmas', tmSearch: 'UD Las Palmas', genre: 'Football', description: 'UD Las Palmas are the main club of Gran Canaria, playing at the Gran Canaria stadium. One of the most colourful clubs in Spanish football, Las Palmas have a passionate island fanbase and play attractive, technical football.' },
  { slug: 'real-valladolid', name: 'Real Valladolid', search: 'Valladolid', tmSearch: 'Real Valladolid', genre: 'Football', description: 'Real Valladolid are a Castilian club with strong links to Brazilian legend Ronaldo who previously owned the club. Playing at the Jose Zorrilla stadium, Valladolid yo-yo between La Liga and the second division.' },

  // Bundesliga (Germany)
  { slug: 'bayern-munich', name: 'Bayern Munich', search: 'Bayern Munich', tmSearch: 'Bayern Munich', genre: 'Football', description: 'Bayern Munich are one of the most successful clubs in European football with a record 32 Bundesliga titles and 6 Champions League trophies. Based at the Allianz Arena, Bayern are one of the most financially powerful clubs in the world.' },
  { slug: 'borussia-dortmund', name: 'Borussia Dortmund', search: 'Borussia Dortmund', tmSearch: 'Borussia Dortmund', genre: 'Football', description: 'Borussia Dortmund are one of Germany\'s most beloved clubs, famous for the Yellow Wall terrace. BVB have won 8 Bundesliga titles and the Champions League in 1997, and are renowned for developing world-class young talent.' },
  { slug: 'bayer-leverkusen', name: 'Bayer Leverkusen', search: 'Bayer Leverkusen', tmSearch: 'Bayer 04 Leverkusen', genre: 'Football', description: 'Bayer Leverkusen won their first Bundesliga title in 2023-24 under Xabi Alonso with an unbeaten season, adding the DFB-Pokal. Based at the BayArena, Leverkusen are now firmly established among Europe\'s elite clubs.' },
  { slug: 'rb-leipzig', name: 'RB Leipzig', search: 'RB Leipzig', tmSearch: 'RB Leipzig', genre: 'Football', description: 'RB Leipzig are a modern German club founded in 2009 who have rapidly risen to the Bundesliga elite. Backed by Red Bull, Leipzig play exciting attacking football and have been Champions League regulars since 2017.' },
  { slug: 'eintracht-frankfurt', name: 'Eintracht Frankfurt', search: 'Eintracht Frankfurt', tmSearch: 'Eintracht Frankfurt', genre: 'Football', description: 'Eintracht Frankfurt are a historic German club and Europa League winners in 2022, defeating Rangers on penalties in Seville. Known for their passionate fanbase and legendary European history, Frankfurt play at Deutsche Bank Park.' },
  { slug: 'vfb-stuttgart', name: 'VfB Stuttgart', search: 'Stuttgart', tmSearch: 'VfB Stuttgart', genre: 'Football', description: 'VfB Stuttgart are a five-time Bundesliga champion who returned to Champions League football in 2024-25 under Sebastian Hoeness. Playing at the MHPArena, Stuttgart have a proud history and a talented squad built on intelligent recruitment.' },
  { slug: 'sc-freiburg', name: 'SC Freiburg', search: 'Freiburg', tmSearch: 'SC Freiburg', genre: 'Football', description: 'SC Freiburg are one of Germany\'s most admired clubs for their sustainable model of developing local talent. Regular European participants, Freiburg consistently punch above their weight and are known for their community spirit.' },
  { slug: 'borussia-monchengladbach', name: 'Borussia Monchengladbach', search: 'Monchengladbach', tmSearch: 'Borussia Monchengladbach', genre: 'Football', description: 'Borussia Monchengladbach, the Foals, are a German club with a proud European pedigree including two UEFA Cups. Playing at Borussia-Park, Gladbach have a passionate following and are known for producing attacking, exciting football.' },
  { slug: 'werder-bremen', name: 'Werder Bremen', search: 'Werder Bremen', tmSearch: 'Werder Bremen', genre: 'Football', description: 'Werder Bremen are one of Germany\'s most storied clubs with 4 Bundesliga titles and the Cup Winners Cup in 1992. Playing at the Weserstadion on the banks of the Weser, Werder have one of German football\'s most atmospheric grounds.' },
  { slug: 'hoffenheim', name: 'TSG Hoffenheim', search: 'Hoffenheim', tmSearch: 'TSG Hoffenheim', genre: 'Football', description: 'TSG Hoffenheim are a modern German club transformed from a small village team through Dietmar Hopp\'s investment. Under a series of ambitious coaches, they have become a consistent Bundesliga presence with a strong player development focus.' },
  { slug: 'fc-augsburg', name: 'FC Augsburg', search: 'Augsburg', tmSearch: 'FC Augsburg', genre: 'Football', description: 'FC Augsburg are a Bavarian club established as Bundesliga regulars since their 2011 promotion. Playing at the WWK Arena, Augsburg are known for their competitive team spirit and impressive results against the traditional big clubs.' },
  { slug: 'vfl-wolfsburg', name: 'VfL Wolfsburg', search: 'Wolfsburg', tmSearch: 'VfL Wolfsburg', genre: 'Football', description: 'VfL Wolfsburg are a club associated with Volkswagen who won the Bundesliga in 2009 under Felix Magath. Based at the Volkswagen Arena, Wolfsburg also have a prominent women\'s team who are multiple Champions League winners.' },
  { slug: 'fsv-mainz-05', name: 'Mainz 05', search: 'Mainz', tmSearch: 'FSV Mainz 05', genre: 'Football', description: 'Mainz 05 are the club famous for launching the managerial careers of Jurgen Klopp and Thomas Tuchel. Playing at the MEWA Arena, the Carnival Club are a consistent Bundesliga presence known for their high-energy pressing style.' },
  { slug: 'union-berlin', name: 'Union Berlin', search: 'Union Berlin', tmSearch: '1. FC Union Berlin', genre: 'Football', description: 'Union Berlin made history reaching the Bundesliga in 2019 and went on to compete in European football. Known for the unique community atmosphere at An der Alten Forsterei, Union have become one of German football\'s great modern stories.' },
  { slug: 'hamburger-sv', name: 'Hamburger SV', search: 'Hamburger SV', tmSearch: 'Hamburger SV', genre: 'Football', description: 'Hamburger SV are one of Germany\'s most famous clubs with 6 Bundesliga titles and a European Cup in 1983. Competing in the second division with ambitions to return, HSV have a huge following and the iconic Volksparkstadion.' },
  { slug: 'schalke-04', name: 'Schalke 04', search: 'Schalke', tmSearch: 'FC Schalke 04', genre: 'Football', description: 'FC Schalke 04 are a working-class club from the Ruhr with one of Germany\'s most passionate fanbases. The Royal Blues have a rich history of domestic and European success and a deeply loyal supporter community in Gelsenkirchen.' },

  // Serie A (Italy)
  { slug: 'juventus', name: 'Juventus', search: 'Juventus', tmSearch: 'Juventus', genre: 'Football', description: 'Juventus are Italy\'s most decorated club with 36 Serie A titles and 2 Champions League trophies. Based in Turin at the Juventus Stadium, the Old Lady have been home to some of the greatest players in football history.' },
  { slug: 'ac-milan', name: 'AC Milan', search: 'AC Milan', tmSearch: 'AC Milan', genre: 'Football', description: 'AC Milan are one of the most successful clubs in European football with 7 Champions League titles. Based at the San Siro in Milan, the Rossoneri are famed for their iconic red and black kit and 19 Serie A titles.' },
  { slug: 'inter-milan', name: 'Inter Milan', search: 'Inter Milan', tmSearch: 'Inter Milan', genre: 'Football', description: 'Inter Milan, officially FC Internazionale, have won 20 Serie A titles and 3 Champions League trophies. Sharing the San Siro with AC Milan, the Nerazzurri have passionate global support and a proud European heritage.' },
  { slug: 'napoli', name: 'Napoli', search: 'Napoli', tmSearch: 'SSC Napoli', genre: 'Football', description: 'SSC Napoli won the Serie A title in 2022-23 in dominant fashion, their third ever. Forever associated with Diego Maradona who led them to their first two titles, Napoli play at the Diego Armando Maradona Stadium in southern Italy.' },
  { slug: 'as-roma', name: 'AS Roma', search: 'AS Roma', tmSearch: 'AS Roma', genre: 'Football', description: 'AS Roma are one of Italy\'s most storied clubs playing at the Olimpico. Conference League winners in 2022, Roma have a passionate fanbase and one of football\'s greatest rivalries with city neighbours Lazio.' },
  { slug: 'lazio', name: 'Lazio', search: 'Lazio', tmSearch: 'SS Lazio', genre: 'Football', description: 'SS Lazio are a Rome club with 2 Serie A titles and a passionate loyal following. Playing at the Olimpico alongside rivals Roma, Lazio have a rich European history and are one of Italy\'s most widely supported clubs.' },
  { slug: 'atalanta', name: 'Atalanta', search: 'Atalanta', tmSearch: 'Atalanta BC', genre: 'Football', description: 'Atalanta BC from Bergamo have become one of Europe\'s most exciting clubs under Gian Piero Gasperini. Europa League winners in 2024, Atalanta are famous for their attacking, goal-heavy football and exceptional player development.' },
  { slug: 'fiorentina', name: 'Fiorentina', search: 'Fiorentina', tmSearch: 'ACF Fiorentina', genre: 'Football', description: 'ACF Fiorentina are a Florentine club with a proud history including 2 Serie A titles. Playing at the Artemio Franchi in one of Italy\'s most beautiful cities, La Viola have been regular European participants in recent seasons.' },
  { slug: 'torino', name: 'Torino FC', search: 'Torino', tmSearch: 'Torino FC', genre: 'Football', description: 'Torino FC are a historic Turin club with 7 Serie A titles, forever remembered for the Superga air disaster of 1949. Playing at the Olimpico Grande Torino, il Toro maintain a fierce and passionate city rivalry with Juventus.' },
  { slug: 'bologna', name: 'Bologna FC', search: 'Bologna', tmSearch: 'Bologna FC', genre: 'Football', description: 'Bologna FC are a historic Emilian club who qualified for the Champions League in 2024-25 for the first time in over 60 years. One of Italian football\'s founding clubs with 7 Serie A titles, Bologna play at the Renato Dall\'Ara.' },
  { slug: 'udinese', name: 'Udinese', search: 'Udinese', tmSearch: 'Udinese Calcio', genre: 'Football', description: 'Udinese Calcio are a Friuli club known for innovative recruitment and player development. The Zebrette play at the Bluenergy Stadium in Udine and have a loyal following in north-east Italy with a proud top-flight history.' },
  { slug: 'hellas-verona', name: 'Hellas Verona', search: 'Hellas Verona', tmSearch: 'Hellas Verona', genre: 'Football', description: 'Hellas Verona are a Veneto club famous for their shock 1984-85 Serie A title under Osvaldo Bagnoli. Verona bounce between Serie A and Serie B and play at the Marcantonio Bentegodi stadium in the city of Romeo and Juliet.' },
  { slug: 'cagliari', name: 'Cagliari', search: 'Cagliari', tmSearch: 'Cagliari Calcio', genre: 'Football', description: 'Cagliari Calcio are the main club of Sardinia and Serie A champions in 1969-70 under the legendary Gigi Riva. Playing at the Unipol Domus, Cagliari represent the island\'s vibrant and passionate football culture.' },
  { slug: 'parma', name: 'Parma Calcio', search: 'Parma', tmSearch: 'Parma Calcio', genre: 'Football', description: 'Parma Calcio had one of Italian football\'s great eras in the 1990s, winning the Cup Winners Cup and UEFA Cup twice. Back in Serie A after their dramatic fall, Parma are rebuilding with ambitions to return to former European glories.' },

  // Ligue 1 (France)
  { slug: 'paris-saint-germain', name: 'Paris Saint-Germain', search: 'Paris Saint-Germain', tmSearch: 'Paris Saint-Germain', genre: 'Football', description: 'Paris Saint-Germain are one of the wealthiest clubs in the world following their 2011 Qatari takeover. Based at the Parc des Princes, PSG have dominated Ligue 1 and attracted some of the greatest players in football history.' },
  { slug: 'olympique-marseille', name: 'Olympique Marseille', search: 'Marseille', tmSearch: 'Olympique de Marseille', genre: 'Football', description: 'Olympique de Marseille are France\'s most passionate club and the only French side to win the Champions League, in 1993. The Velodrome is one of Europe\'s most atmospheric stadiums with a massive following across the French-speaking world.' },
  { slug: 'olympique-lyonnais', name: 'Olympique Lyon', search: 'Lyon', tmSearch: 'Olympique Lyonnais', genre: 'Football', description: 'Olympique Lyonnais are the most dominant club in French football history, winning seven consecutive Ligue 1 titles from 2002 to 2008. Lyon play at the Groupama Stadium and have a strong women\'s team and talented youth academy.' },
  { slug: 'monaco', name: 'AS Monaco', search: 'Monaco', tmSearch: 'AS Monaco', genre: 'Football', description: 'AS Monaco are a principality club who won the Ligue 1 title in 2016-17 with one of Europe\'s most exciting young squads. Based at the Stade Louis II, Monaco have a history of developing and selling elite talent.' },
  { slug: 'nice', name: 'OGC Nice', search: 'Nice', tmSearch: 'OGC Nice', genre: 'Football', description: 'OGC Nice are a Riviera club who have become regular European participants under ambitious ownership. Playing at the modern Allianz Riviera, Nice are developing a competitive squad with Champions League ambitions.' },
  { slug: 'stade-rennais', name: 'Stade Rennais', search: 'Rennes', tmSearch: 'Stade Rennais FC', genre: 'Football', description: 'Stade Rennais are a Breton club who have developed into one of Ligue 1\'s most consistent performers and regular Europa League participants. Rennes are known for their excellent academy and attractive passing football.' },
  { slug: 'rc-lens', name: 'RC Lens', search: 'Lens', tmSearch: 'RC Lens', genre: 'Football', description: 'RC Lens are a mining community club from northern France with one of Ligue 1\'s most passionate fanbases. Champions in 1998, Lens have returned to European football at the famous Stade Bollaert-Delelis in recent seasons.' },
  { slug: 'stade-brestois', name: 'Stade Brestois', search: 'Brest', tmSearch: 'Stade Brestois 29', genre: 'Football', description: 'Stade Brestois 29 made history in 2023-24 by finishing second in Ligue 1 and qualifying for the Champions League for the first time. The Breton club from Finistere are a remarkable story of sustainable growth in French football.' },
  { slug: 'lille-osc', name: 'LOSC Lille', search: 'Lille', tmSearch: 'LOSC Lille', genre: 'Football', description: 'LOSC Lille are Ligue 1 champions in 2020-21 after one of the most dramatic title races in French football history. Based at Stade Pierre-Mauroy, Lille are known for elite talent recruitment and have produced stars like Eden Hazard.' },
  { slug: 'rc-strasbourg', name: 'RC Strasbourg', search: 'Strasbourg', tmSearch: 'RC Strasbourg Alsace', genre: 'Football', description: 'RC Strasbourg Alsace are an Alsatian club with a loyal local following. Ligue 1 champions in 1979, Strasbourg play at the La Meinau stadium and represent the unique Franco-German culture of the Alsace region.' },

  // Eredivisie (Netherlands)
  { slug: 'ajax', name: 'Ajax', search: 'Ajax', tmSearch: 'AFC Ajax', genre: 'Football', description: 'AFC Ajax are the Netherlands most successful club and one of the most storied in European football, having won 4 Champions League titles and pioneered the Total Football philosophy. Ajax play at the Johan Cruyff Arena in Amsterdam.' },
  { slug: 'psv-eindhoven', name: 'PSV Eindhoven', search: 'PSV Eindhoven', tmSearch: 'PSV Eindhoven', genre: 'Football', description: 'PSV Eindhoven are a major Dutch club with 24 Eredivisie titles and the European Cup in 1988. Backed by Philips, PSV play at the Philips Stadion and are regular Champions League participants known for developing world-class talent.' },
  { slug: 'feyenoord', name: 'Feyenoord', search: 'Feyenoord', tmSearch: 'Feyenoord', genre: 'Football', description: 'Feyenoord are Rotterdam\'s famous club and one of Dutch football\'s big three. Winners of the European Cup in 1970 and the UEFA Cup in 2002, Feyenoord play at De Kuip and have one of the most passionate fanbases in world football.' },
  { slug: 'az-alkmaar', name: 'AZ Alkmaar', search: 'AZ Alkmaar', tmSearch: 'AZ Alkmaar', genre: 'Football', description: 'AZ Alkmaar are a Dutch club from North Holland who won the Eredivisie in 2009 and are regular European participants. Known for their progressive approach to football and player development, AZ play at the AFAS Stadion.' },

  // Primeira Liga (Portugal)
  { slug: 'porto', name: 'FC Porto', search: 'FC Porto', tmSearch: 'FC Porto', genre: 'Football', description: 'FC Porto are Portugal\'s most successful club in European terms, winning the Champions League in 1987 and 2004 under Jose Mourinho. Based at the Estadio do Dragao, Porto are consistently competitive in European football.' },
  { slug: 'benfica', name: 'Benfica', search: 'Benfica', tmSearch: 'SL Benfica', genre: 'Football', description: 'SL Benfica are one of Portugal\'s most successful clubs with 38 Primeira Liga titles and 2 European Cups. Based at the Estadio da Luz in Lisbon, Benfica are one of the most widely supported clubs in the world.' },
  { slug: 'sporting-cp', name: 'Sporting CP', search: 'Sporting CP', tmSearch: 'Sporting CP', genre: 'Football', description: 'Sporting CP are a major Lisbon club with 19 Primeira Liga titles. Known for one of football\'s most celebrated academies that produced Cristiano Ronaldo, Sporting play at the Jose Alvalade stadium.' },
  { slug: 'braga', name: 'SC Braga', search: 'Braga', tmSearch: 'SC Braga', genre: 'Football', description: 'SC Braga are northern Portugal\'s biggest club and regular European participants, having reached the Europa League final in 2011. Playing at the spectacular Municipal de Braga stadium carved into a granite hillside, Braga are a consistent Portuguese force.' }

];

export async function onRequestGet({ request, env }) {
  const url  = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return jsonResponse({ error: 'slug is required' }, 400);
  }

  // Normalise slug — strip common suffixes that TM/search appends
  // e.g. 'chelsea-fc' → 'chelsea', 'manchester-united-fc' → 'manchester-united'
  let normSlug = slug.toLowerCase()
    .replace(/-f-c$/, '')        // trailing -f-c
    .replace(/-fc$/, '')         // trailing -fc  
    .replace(/-afc$/, '')        // trailing -afc (AFC Bournemouth etc)
    .replace(/-football-club$/, '') // trailing -football-club
    .replace(/-soccer$/, '');    // trailing -soccer
  normSlug = normSlug.replace(/-+$/, ''); // clean trailing dashes

  let team = TEAMS.find(t => t.slug === normSlug)
           || TEAMS.find(t => t.slug === slug.toLowerCase()); // fallback to raw slug

  // If not in hardcoded list, check KV for auto-discovered team data
  if (!team) {
    const kv = env.GIGSBERG_KV;
    if (kv) {
      try {
        const kvData = await kv.get(`football:team:${normSlug}`);
        if (kvData) {
          team = JSON.parse(kvData);
        }
      } catch {}
    }
  }

  // Fallback — try Awin events for this team name (metadata only, not events)
  if (!team) {
    const name = toTitleCase(normSlug.replace(/-/g, ' '));
    try {
      const origin   = new URL(request.url).origin;
      const awinUrl  = `${origin}/api/awin-events?name=${encodeURIComponent(name)}&size=1`;
      const awinResp = await fetch(awinUrl);
      if (awinResp.ok) {
        const awinData = await awinResp.json();
        if (awinData.events && awinData.events.length > 0) {
          team = {
            slug:        normSlug,
            name,
            search:      name,
            tmSearch:    name,
            genre:       'Football',
            description: `Compare ${name} ticket prices across verified sellers. Find the best deals on ${name} match tickets and buy direct from verified sellers.`
          };
        }
      }
    } catch {}

    // Synthesise from slug for any unknown football club — club names are
    // often single words (Fulham, Everton) and KV may have expired.
    // TM lookup will still find them by reconstructed name.
    if (!team) {
      const displayName = toTitleCase(normSlug.replace(/-/g, ' '));
      team = {
        slug:        normSlug,
        name:        displayName,
        search:      displayName,
        tmSearch:    displayName,
        genre:       'Football',
        description: `Compare ${displayName} ticket prices across verified sellers on TicketScout.`
      };
    }
  }

  // Resolve Ticketmaster attraction ID for this team
  const apiKey = env.TM_API_KEY;
  let attractionId = null;
  let tmImage      = null;

  if (apiKey) {
    try {
      const tmUrl = new URL('https://app.ticketmaster.com/discovery/v2/attractions.json');
      tmUrl.searchParams.set('apikey', apiKey);
      tmUrl.searchParams.set('keyword', team.tmSearch || team.search);
      tmUrl.searchParams.set('classificationName', 'Sports');
      tmUrl.searchParams.set('size', '10');

      const tmResp = await fetch(tmUrl.toString());
      const tmData = await tmResp.json();
      const attractions = tmData?._embedded?.attractions || [];

      if (attractions.length > 0) {
        const normSearch = (team.tmSearch || team.search).toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

        const scored = attractions.map(a => {
          const normName = (a.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
          let score = 0;
          if (normName === normSearch)              score = 100;
          else if (normName.startsWith(normSearch)) score = 50;
          else if (normName.includes(normSearch))   score = 20;
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
    team: {
      slug:        team.slug,
      name:        team.name,
      genre:       team.genre || 'Football',
      description: team.description,
      search:      team.search
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