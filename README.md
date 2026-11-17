# Ambassadeur

Site: https://ambassadeur.boaportaal.nl

Draai eerst `schema.sql` in de Supabase SQL-editor.

Netlify-variabelen, dezelfde waarden als bij systeem waar dat zo staat:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PURELYMAIL_API_TOKEN` zodat de postbussen vanzelf worden aangemaakt
- `UITNODIGING_PASSWORD` het wachtwoord van uitnodiging@ambassadeur.boaportaal.nl
- `NOREPLY_PASSWORD` het wachtwoord van noreply@boaportaal.nl

Op de mail-site, alleen voor de medewerkers van BOA Portaal:

- `PURELYMAIL_AMBASSADEUR_PASSWORD` voor ambassadeur@boaportaal.nl
- `PURELYMAIL_AMBSUPPORT_PASSWORD` voor support@ambassadeur.boaportaal.nl

Maak in Purelymail deze postbussen aan als ze er nog niet zijn:

- uitnodiging@ambassadeur.boaportaal.nl
- noreply@boaportaal.nl
- ambassadeur@boaportaal.nl
- support@ambassadeur.boaportaal.nl
