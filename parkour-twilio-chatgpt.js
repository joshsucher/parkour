const twilio = require('twilio');
const OpenAI = require("openai").default;
const nominatimClient = require('nominatim-client');
const axios = require('axios');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const OPEN_CURB_API_ENDPOINT = 'http://www.opencurb.nyc/search.php';
const NYC_CALENDAR_API_ENDPOINT = 'https://api.nyc.gov/public/api/GetCalendar';
const NYC_SUBSCRIPTION_KEY = process.env.Ocp_Apim_Subscription_Key; // Replace with your actual subscription key

// In-memory store for demonstration. In a real-world scenario, consider using a database.
let conversations = {};

// Default model and settings
let currentSettings = {
    model: "gpt-3.5-turbo",
    temperature: 1,
    max_tokens: 256,
    top_p: 1,
    system: "You are a GPS agent. Respond ONLY with a normalized place name or street address based on the question I've asked or the info I've provided, stripping all extraneous details. I should be able to pipe your reply directly into a mapping API."
};

const geocoder = nominatimClient.createClient({
  useragent: "parkour", // Replace with the name of your application
  referer: 'http://parkour.io', // Replace with the referer link appropriate for your app
});

exports.handler = async function(context, event, callback) {
        const twiml = new twilio.twiml.MessagingResponse(); // Create a TwiML response
    try {
        // The incoming text message content (which should contain the address) is in `event.Body`
        const incomingAddress = event.Body; // Assuming that the whole body of the message is the address
        console.log("Received address from incoming SMS:", incomingAddress);

    const sender = event.From;
    conversations[sender] = [
      { role: "system", content: currentSettings.system }
    ];

  // Append the user's message
  conversations[sender].push({ role: "user", content: incomingAddress });

  const openai = new OpenAI({
    key: process.env.OPENAI_API_KEY
  });

       let response = await openai.chat.completions.create({
            model: currentSettings.model,
            messages: conversations[sender],
            temperature: currentSettings.temperature,
            max_tokens: currentSettings.max_tokens,
            top_p: currentSettings.top_p,
            frequency_penalty: currentSettings.frequency_penalty
        });

  console.log("Generated Reply:", response.choices[0].message.content);

  // Extract the assistant's message from the response and append it to the conversation history
  const assistantMsg = response.choices[0].message.content;

        response = await fetchLatLngAndParking(assistantMsg); // Pass the address text to your function

        twiml.message(response); // Add the response message to the TwiML messaging response
        callback(null, twiml); // Send the TwiML response back to the user
    } catch (error) {
        console.error('Error:', error.message);
        twiml.message('Sorry, there was an error processing your request.'); // Send an error message to the user
        callback(null, twiml);
    }
};

async function fetchLatLngAndParking(address) {
    try {
        const geolocationData = await getGeolocation(address);
        if (!geolocationData.lat || !geolocationData.lon) {
            return "Sorry, we weren't able to find parking regulations near you. Please try again!";
        }

        const parkingData = await queryOpenCurbApi(geolocationData.lat, geolocationData.lon);
        const freeParkingTimes = await parseOpenCurbData(parkingData);
        const bestTimes = await findBestParkingTimes(freeParkingTimes, 3);
        const statuses = await checkParkingStatus();

        // Building a return message
        let message = '';
        if (bestTimes.length > 0) {
            const bestTimeData = bestTimes[0];
            message += `The best time to park near ${geolocationData.normalizedAddress} is ${bestTimeData.time}, with alternate-side parking restrictions ending on ${bestTimeData.count} nearby streets.\n\n`;
        
            bestTimes.forEach((timeData, index) => {
                if (index > 0) {
                message += `The ${getOrdinal(index + 1)} best time to park is ${timeData.time}, with alternate-side parking restrictions ending on ${timeData.count} nearby streets.\n\n`;
                }
              }); 
        } else {
            message += "No free parking times found.\n\n";
        }

        message += statuses;

        return message;
    } catch (error) {
        // In case of any error during fetching lat/lon or subsequent steps, return the error message
        console.error("Error in fetchLatLngAndParking function:", error);
        return "Sorry, we weren't able to find parking regulations near you. Please try again!";
    }
}

async function getGeolocation(address) {
  try {
    const query = {
      q: address,
      addressdetails: 1
    };
    
    const results = await geocoder.search(query);
    console.log('Nominatim API response:', JSON.stringify(results[0], null, 2)); // Add this log to check the API response

    if (results && results.length > 0) {
      const location = results[0];
      
      // Check Nominatim API response format and adapt the code as needed
      const { house_number, road, suburb, city } = location.address || {};
      
      let normalizedAddress = `${house_number || ''} ${road || ''}`.trim();
      if (suburb) {
        normalizedAddress += `, ${suburb}`;
      }
      
      if (city === 'City of New York') {
        const lat = parseFloat(location.lat);
        const lon = parseFloat(location.lon);
        return { lat, lon, normalizedAddress };
      } else {
        console.log('City from Nominatim is not New York:', location.address); // Add this log
      }
    } else {
      console.log('No results from Nominatim for address:', address); // Add this log
    }
} catch (error) {
    console.error('Geolocation error:', error); // This log is already in place
    throw new Error("Geolocation failed - geocoder");
  }
}

async function queryOpenCurbApi(lat, long) {
    const today = dayjs().format('YYYY-MM-DD');
    const url = `${OPEN_CURB_API_ENDPOINT}?coord=${lat},${long}&v_type=PASSENGER&a_type=PARK&meter=0&radius=200&StartDate=2023-11-12&StartTime=00:00&EndDate=2023-11-12&EndTime=23:59&action_allowed=1`;
    const response = await axios.get(url);
    return response.data;
}

async function parseOpenCurbData(data) {
    let freeParkingTimes = {};

    data.features.forEach(feature => {
        const rule = feature.properties.rule_simplified;
        console.log(rule)
        if (rule.includes('Free Parking')) {
            const start_time_str = rule.split('From')[1].split('Until')[0].trim().replace('.','');
            console.log(start_time_str)
            const start_time = dayjs(start_time_str, 'MMM DD ddd hh:mma');
            console.log(start_time)
            const formattedTime = dayjs(start_time).format('dddd [at] hh:mma');
            console.log(formattedTime)
            freeParkingTimes[formattedTime] = (freeParkingTimes[formattedTime] || 0) + 1;
            console.log(freeParkingTimes[formattedTime])
        }
    });

    return freeParkingTimes;
}

async function findBestParkingTimes(freeParkingTimes, numBest) {
    function isWithinTimeRange(timeStr, startHour = 9, endHour = 18) {
        const time = dayjs(timeStr, 'dddd [at] hh:mma');
        console.log(time);
        return startHour <= time.hour() && time.hour() < endHour;
    }

    let sortedTimes = [];
    Object.entries(freeParkingTimes).forEach(([time, count]) => {
        if (isWithinTimeRange(time)) {
            sortedTimes.push({ time, count });
        }
    });
    
    sortedTimes.sort((a, b) => b.count - a.count);
    console.log(sortedTimes.slice(0, numBest))
    return sortedTimes.slice(0, numBest);
}

function getOrdinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function checkParkingStatus() {
    const todayDate = dayjs().format('MM-DD-YYYY');
    const endDate = dayjs().add(90, 'day').format('MM-DD-YYYY');
    const url = `${NYC_CALENDAR_API_ENDPOINT}?fromdate=${todayDate}&todate=${endDate}`;
    const headers = {
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': NYC_SUBSCRIPTION_KEY
    };

    const response = await axios.get(url, { headers });
    let message = '';

let suspensionDates = [];
let meterExceptions = new Set();

response.data.days.forEach(day => {
    const dateObject = dayjs(day.today_id, 'YYYYMMDD');
    const formattedDate = dateObject.format('dddd, MM/DD');
    day.items.forEach(item => {
        if (item.type === 'Alternate Side Parking' && item.status === 'SUSPENDED') {
            suspensionDates.push(formattedDate);
            if (item.details.includes('meters are suspended')) {
                let exceptionName = item.exceptionName.replace(/\s+\d{4}$/, ''); // Remove the year
                meterExceptions.add(exceptionName);
            }
        }
    });
});

if (suspensionDates.length > 0) {
    message += '\n\nBy the way, alternate side parking is suspended on ';
    if (suspensionDates.length > 1) {
        const lastDate = suspensionDates.pop();
        message += `${suspensionDates.join(', ')}${suspensionDates.length > 1 ? ',' : ''} and ${lastDate}`;
    } else {
        message += `${suspensionDates[0]}`;
    }
    message += '. ';
}

if (meterExceptions.size > 0) {
    message += 'Meters are in effect except for ';
    const exceptionList = Array.from(meterExceptions);
    if (exceptionList.length > 1) {
        const lastException = exceptionList.pop();
        message += `${exceptionList.join(', ')} and ${lastException}`;
    } else {
        message += `${exceptionList[0]}`;
    }
    message += '.';
}

// Check if we have any message to output or fallback to a default message.
message = message.trim() || "";

    return message;
}

function lowercaseFirstChar(s) {
    return s.charAt(0).toLowerCase() + s.slice(1);
}