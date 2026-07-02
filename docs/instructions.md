# Create an Itinerary Builder / Viewer Website in React
Create an itinerary builder website that allows a user to create travel itineraries. The home page should list existing "Trip Itineraries", if any, and allow the user to create a new Trip Itinerary. A "Trip Itinerary", such as "Europe 2026" or "Disneyland July 2026" is an itinerary comprised of multiple daily itineraries. The application should be build with React and a simple node backend server.

## Stack/Technology
Use React for the front-end and a simple Node express server for the API. We won't use any third-party services for data storage/access, instead data will be stored on the server in simple json files or whatever is the most simple file-based solution. The website should be beautifully created with CSS. Use of a CSS framework is fine, but might be overkill for such a simple site. The application should be very simple to deploy to a basic ngnix server. The react application  should be easily deployable as a client-side only React app.

## Home Page
The home page should list existing "Trip Itineraries", if any, and allow the user to create a new Trip Itinerary. If a user clicks on a trip itinerary, or create's a new trip itinerary, it should take them to the Trip Itinerary page.

## Trip Itinerary Page
A blank trip itinerary page should allow the user to add dates to the itinerary using a date picker to select a date range. Once a date range is selected, those dates should be displayed in a clickable list along the left side of the page (each day shown separately, in order, in a vertical list along the left side of the page). When a user clicks on a date, it should display that days itinerary on the right (UI defined below). If that day's itinerary has not yet been created, the user should be presented with two large text area boxes to paste in the CSV for that day's itinerary and the itinerary details. The CSV for a days itinerary will look similar to this example:

```
Time,Plan,Detail
8:00 am,Leave Holiday Inn West Yellowstone,S1
8:05–8:40,Enter park and drive to Madison Junction,S2
8:50–9:35,Fountain Paint Pot,S3
9:45–11:15,Grand Prismatic Overlook Trail,S4
11:15–11:55,Optional Midway Geyser Basin boardwalk,S5
11:55–12:30,Picnic lunch / quick lunch,S6
```

The itinerary details will be markdown that looks like this example:
```
## S1 — Leave Holiday Inn West Yellowstone

Leave at **8:00 am** from Holiday Inn West Yellowstone, 315 Yellowstone Ave. Since you’re already in West Yellowstone, this gives you a major advantage over starting in Rexburg.

Try to have gas, snacks, water, and lunch supplies ready before leaving.

---

## S2 — Enter park and drive to Madison Junction

You’ll enter through the **West Entrance** and follow the Madison River toward **Madison Junction**.

This is a pretty first drive into the park. Watch for elk, bison, and misty river scenery, but don’t spend too much time stopping yet since the day is full.

---

## S3 — Fountain Paint Pot

**Fountain Paint Pot** is one of the best short geothermal stops in Yellowstone.

Why it’s worth doing:

- Easy boardwalk
- About 0.5 miles
- Mud pots, fumaroles, hot springs, and small geysers
- Great variety in a short amount of time

This is the top priority among the smaller west-side geothermal stops.
...
```

Notice that the itinerary details markdown for each detail section is divided byt he `---` markdown. Also notice that the title for each detail section is formated like: `## S1 — Leave Holiday Inn West Yellowstone`. The `S#` code (i.e. `S1`, `S2`, etc.) corresponds to the values in the 3rd field of the previously pasted CSV data. So these itinerary detail sections correspond to and can be matched up to each itinerary line for that day.

Once submitted, the editable text areas should then be replaced with UI that display's that day's itinerary, with one line per CSV line and with the "Time" and "Plan" displayed in columns so that the plan/title text for each line are left aligned, displayed after the time column. Each line in this daily itinerary should be collapsible/expandable so that the previously matched itnerary details are hidden by default but displayed for an item when that item is clicked. For example, using the sample data above. The first row in the itinerary table would display: 8:00 am | Leave Holiday Inn West Yellowstone. And then when that row is clicked it would expand to show that's item's detailed in rendered markdwon which would be:
```
## Leave Holiday Inn West Yellowstone

Leave at **8:00 am** from Holiday Inn West Yellowstone, 315 Yellowstone Ave. Since you’re already in West Yellowstone, this gives you a major advantage over starting in Rexburg.

Try to have gas, snacks, water, and lunch supplies ready before leaving.
```

Once an trip itinerary is created, each itinerary item for each day should be editable so that the user can modify the title or details.