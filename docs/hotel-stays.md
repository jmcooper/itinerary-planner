# Hotel Stays UI
I'm trying to determine the best UI for adding hotel stay details to my itinerary. I want this to accomplish a few things: 
1. An easy way to add hotel stays, either manually throught the UI or via description to the AI agent; 
2. An easy way to see all booked hotel stays for the itinerary; 
3. An easy way to find confirmation # when I'm checking into a hotel on a given day; 
4. An easy way to find and click on the hotel's address to navigate to the hotel via google maps; 
5. A way to identify that a hotel stay is not needed for a particular day; 
6. A clear indicator if I'm missing a hotel stay for a given day. Data for a hotel stay should include: { hotelName, hotelAddress, checkInDay, checkOutDay }. The hotel stays should be stored at the trip level, not at the day level since they can span multiple days.

## Adding/Viewing Hotel Stays
For #1 and #2, I'm thinking of maybe modal pop-ups on the trip page with a link to add/view hotel stays next to the "Add days" link in the trip header, but I'm open to alternate ideas.

## Viewing Hotel Info for a Given Booking
For #3 & #4, I'm thinking it'd be nice on the days we have check-in and check-out events for a hotel stay to show icons on the day tile (the tiles we click on to show a day's itinerary) as well as larger, easier to click/tap icons to the right of the day's title when viewing a day's itinerary. For days where we check-in to a hotel the icon should be a house icon with a green arrow pointing into the house from the left. For days where we check-out of a hotel the icon should be a house icon with a red arrow leaving the house to the right. It's possible a day would have both icons, in which case the check-out icon should be displayed first. Clicking these icons (either the small ones in the day tiles or the larger ones in the day header), it should open a modal showing just that hotel's information.

## Indicating a Hotel Stay is Not Needed for a Given Day
For #5, if a particular day isn't included in a hotel stay, there should be an option at the top of that day's itinerary to add a hotel stay as well as an option for "Hotel stay not needed this day". While the other hotel data is stored at the trip level, this "Hotel stay not needed" flag should be at the day level.

## Missing Hotel Stay Indicators
For #6, I'm thinking it'd be good if the day title showed in a slight red color if that day isn't included in a hotel stay (and the day is not marked as not needing a hotel stay), and then some warning indicator at the top of the day's itinerary. Keep in mind that the hotel info stores a check-in date and a check-out date and a particular day is considered to have a hotel stay if it is anywhere in the date range between checkInDay (inclusive) and checkOutDay (exclusive).