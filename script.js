let favoriteCountries = JSON.parse(localStorage.getItem('favorites')) || [];

document.getElementById('search-btn').addEventListener('click', fetchCountries);

async function fetchCountries() {
    const countryInput = document.getElementById('country').value.toLowerCase();
    const continent = document.getElementById('continent').value;
    const minPopulation = document.getElementById('min-population').value;
    const maxPopulation = document.getElementById('max-population').value;
    const minArea = document.getElementById('min-area').value;
    const maxArea = document.getElementById('max-area').value;

    try {
        const response = await fetch('https://restcountries.com/v3.1/all');
        const countries = await response.json();

        const filteredCountries = countries.filter(country => {
            const countryName = country.name.common.toLowerCase();
            const population = country.population || 0;
            const area = country.area || 0;

            return (
                (!countryInput || countryName.includes(countryInput)) &&
                (!continent || country.region === continent) &&
                (!minPopulation || population >= minPopulation) &&
                (!maxPopulation || population <= maxPopulation) &&
                (!minArea || area >= minArea) &&
                (!maxArea || area <= maxArea)
            );
        });

        displayResults(filteredCountries);
        updateFavoritesList(); // Favori ülkeleri güncelle
    } catch (error) {
        console.error('Error fetching countries:', error);
    }
}

function displayResults(countries) {
    const resultDiv = document.getElementById('result');
    resultDiv.innerHTML = '';

    if (countries.length === 0) {
        resultDiv.innerHTML = '<p>No countries found</p>';
        return;
    }

    countries.forEach(country => {
        const isFavorite = favoriteCountries.includes(country.name.common);
        const countryDiv = document.createElement('div');
        countryDiv.classList.add('country-item');
        countryDiv.innerHTML = `
            <h2>${country.name.common}</h2>
            <img src="${country.flags.svg}" alt="Flag of ${country.name.common}" width="100">
            <p><strong>Population:</strong> ${country.population ? country.population.toLocaleString() : 'N/A'}</p>
            <p><strong>Area:</strong> ${country.area ? country.area.toLocaleString() : 'N/A'} km²</p>
            <p><strong>Continent:</strong> ${country.region || 'N/A'}</p>
            <button class="favorite-btn ${isFavorite ? 'remove' : ''}" onclick="toggleFavorite('${country.name.common}')">
                ${isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
            </button>
        `;
        resultDiv.appendChild(countryDiv);
    });
}

function toggleFavorite(countryName) {
    if (favoriteCountries.includes(countryName)) {
        favoriteCountries = favoriteCountries.filter(country => country !== countryName);
    } else {
        favoriteCountries.push(countryName);
    }

    localStorage.setItem('favorites', JSON.stringify(favoriteCountries));
    fetchCountries(); // Favori değişikliklerinden sonra tekrar ülke verilerini al
}
function updateFavoritesList() {
    const favoritesList = document.getElementById('favorites-list');
    favoritesList.innerHTML = '';

    if (favoriteCountries.length === 0) {
        favoritesList.innerHTML = '<li>No favorites yet</li>';
        return;
    }

    favoriteCountries.forEach(async countryName => {
        try {
            const response = await fetch(`https://restcountries.com/v3.1/name/${countryName}`);
            const countryData = await response.json();
            const country = countryData[0];
            
            const li = document.createElement('li');
            li.innerHTML = `
                <img src="${country.flags.svg}" alt="Flag of ${country.name.common}" width="50">
                ${country.name.common}
                <button class="remove-btn" onclick="removeFavorite('${country.name.common}')">Remove</button>
            `;
            favoritesList.appendChild(li);
        } catch (error) {
            console.error('Error fetching country data for favorites:', error);
        }
    });
}

function removeFavorite(countryName) {
    favoriteCountries = favoriteCountries.filter(country => country !== countryName);
    localStorage.setItem('favorites', JSON.stringify(favoriteCountries));
    updateFavoritesList();
}

function toggleFavorites() {
    const favoritesList = document.querySelector('.favorites-list');
    const isVisible = favoritesList.style.display === 'block';
    favoritesList.style.display = isVisible ? 'none' : 'block';
}

document.addEventListener('DOMContentLoaded', () => {
    fetchCountries(); // Sayfa yüklendiğinde mevcut favori ülkeleri göster
    updateFavoritesList();
});
Document